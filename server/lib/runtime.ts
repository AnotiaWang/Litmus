/**
 * 运行时装配：按配置创建数据库、行情客户端和引擎，整个进程共用一份。
 *
 * 只有 server/plugins、server/api 等框架层调用这里；server/lib 的其他模块都通过参数接收依赖，便于测试。
 */
import { join } from 'node:path'
import { bootstrap, type AdminDeps } from './admin'
import { loadEnvConfig, type EnvConfig } from './config'
import { archiveLegacyDatabase, Store, type AgentRow } from './db'
import { Engine } from './engine'
import { OpenAiLlm, type Decider } from './llm'
import { enableFileLog, log, setSecrets } from './logger'
import { BinanceMarket } from './market'

export interface Runtime extends AdminDeps {
  env: EnvConfig
  store: Store
  market: BinanceMarket
  engine: Engine
  /** 下次定时运行时间（ISO），由启动插件维护 */
  nextRunAt: string | null
}

let runtime: Runtime | null = null

/**
 * 按模型取 LLM 客户端。客户端会记住“这个服务不支持 response_format”之类的状态，所以按模型缓存；
 * Provider 的地址或 Key、模型的超时改了以后自动换新的。
 */
export function createDeciderCache(store: Store): (agent: AgentRow) => Decider {
  const cache = new Map<number, { key: string, llm: OpenAiLlm }>()
  return (agent) => {
    const provider = agent.providerId === null ? null : store.getProvider(agent.providerId)
    if (!provider || !agent.model) throw new Error(`模型 ${agent.name} 没有可用的 Provider`)
    const opts = {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      extraParams: agent.extraParams,
      timeoutMs: (agent.timeoutSeconds ?? 120) * 1000
    }
    const key = JSON.stringify(opts)
    const hit = cache.get(agent.id)
    if (hit?.key === key) return hit.llm
    const llm = new OpenAiLlm(opts)
    cache.set(agent.id, { key, llm })
    return llm
  }
}

/** 首次调用时读取配置并创建各组件；配置不合法会抛出 ConfigError。 */
export function getRuntime(): Runtime {
  if (runtime) return runtime
  const env = loadEnvConfig()
  enableFileLog(join(env.dataDir, 'logs'))

  const dbPath = join(env.dataDir, 'litmus.db')
  const backup = archiveLegacyDatabase(dbPath)
  if (backup) log.warn(`发现旧版本的数据库，已改名备份为 ${backup}，从空数据库重新开始`)
  const store = new Store(dbPath)
  bootstrap(store)

  const refreshSecrets = () => setSecrets([env.adminToken, ...store.listProviders().map(p => p.apiKey)])
  refreshSecrets()
  const market = new BinanceMarket()
  const deciderFor = createDeciderCache(store)
  const engine = new Engine({ store, market, deciderFor })
  runtime = { env, store, market, engine, deciderFor, refreshSecrets, nextRunAt: null, reschedule: () => {} }
  return runtime
}
