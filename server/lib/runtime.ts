/**
 * 运行时装配：按配置创建数据库、交易所客户端、LLM 和引擎，整个进程共用一份。
 *
 * 只有 server/plugins、server/api 等框架层调用这里；server/lib 的其他模块都通过参数接收依赖，便于测试。
 */
import { join } from 'node:path'
import { loadEnvConfig, resolveConfig, secretsOf, type Config, type EnvConfig } from './config'
import { Store } from './db'
import { Engine } from './engine'
import { BinanceClient } from './exchange'
import { OpenAiLlm } from './llm'
import { enableFileLog, setSecrets } from './logger'

export interface Runtime {
  /** 环境变量里的配置，改了需要重启 */
  env: EnvConfig
  /** 当前生效的配置：环境变量 + 面板里的设置（每次调用都读最新的设置） */
  config: () => Config
  store: Store
  exchange: BinanceClient
  /** 没有配置 LLM 连接信息时为 null；复核和决策共用 */
  reviewer: OpenAiLlm | null
  engine: Engine
  /** 下次定时运行时间（ISO），由启动插件维护 */
  nextRunAt: string | null
  /** 按最新的运行间隔重新排定下次运行，由启动插件设置 */
  reschedule: () => void
}

let runtime: Runtime | null = null

/** 首次调用时读取配置并创建各组件；配置不合法会抛出 ConfigError。 */
export function getRuntime(): Runtime {
  if (runtime) return runtime
  const env = loadEnvConfig()
  setSecrets(secretsOf(env))
  enableFileLog(join(env.dataDir, 'logs'))

  const store = new Store(join(env.dataDir, 'litmus.db'))
  const config = () => resolveConfig(env, store.getSettings())
  const exchange = new BinanceClient({
    baseUrl: env.binance.baseUrl,
    apiKey: env.binance.apiKey,
    apiSecret: env.binance.apiSecret
  })
  const reviewer = env.llm.configured
    ? new OpenAiLlm(env.llm)
    : null
  const engine = new Engine({ config, exchange, reviewer, decider: reviewer, store })
  runtime = { env, config, store, exchange, reviewer, engine, nextRunAt: null, reschedule: () => {} }
  return runtime
}
