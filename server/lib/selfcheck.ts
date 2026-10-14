/**
 * 部署后自检：`docker compose run --rm -e SELFCHECK=1 app`
 *
 * 依次检查行情接口和每个参赛中的 LLM 模型（用当前行情问一次，不记录、不交易），逐项输出结果。
 * 管理页面里也可以单独测试某个模型。
 */
import type { LlmCall } from '../../shared/types/api'
import { DEFAULT_SEASON_CONFIG } from '../../shared/settings'
import { testAgent, type AdminDeps } from './admin'
import { KLINE_LIMIT } from './engine'

export async function runSelfcheck(deps: AdminDeps, print: (line: string) => void = console.log): Promise<boolean> {
  const { store, market } = deps
  let failed = 0
  const add = (name: string, ok: boolean, detail: string) => {
    if (!ok) failed++
    print(`${ok ? '✅ 通过' : '❌ 失败'}  ${name}：${detail}`)
  }
  const msg = (e: unknown) => (e as Error).message

  const season = store.currentSeason()
  const config = season?.config ?? DEFAULT_SEASON_CONFIG
  print(`自检开始：${season ? season.name : '（没有进行中的赛季，按默认配置）'}，交易对 ${config.symbol}，决策周期 ${config.klineInterval}`)

  let marketOk = false
  try {
    const rules = await market.getSymbolRules(config.symbol)
    const klines = await market.getKlines(config.symbol, config.klineInterval, KLINE_LIMIT + 1)
    const price = await market.getPrice(config.symbol)
    add('行情接口', true, `${rules.baseAsset}/${rules.quoteAsset} 现价 ${price.toFixed()}，最小下单额 ${rules.minNotional.toFixed()} ${rules.quoteAsset}，获取到 ${klines.length} 根 K 线`)
    marketOk = true
  } catch (e) {
    add('行情接口', false, msg(e))
  }

  const agents = store.listAgents().filter(a => a.kind === 'llm' && a.status === 'active')
  if (!agents.length) print('没有参赛中的 LLM 模型，跳过模型检查。在面板「管理」里添加 Provider 和模型')
  for (const agent of agents) {
    const name = `模型 ${agent.name}（${agent.model}）`
    if (!marketOk) {
      add(name, false, '跳过（行情接口不通）')
      continue
    }
    try {
      const r = await testAgent(deps, agent.id)
      if (r.ok) {
        add(name, true, `返回合法 JSON（耗时 ${(r.durationMs / 1000).toFixed(1)} 秒，超时上限 ${agent.timeoutSeconds ?? 120} 秒）：${r.action} ${r.sizePct}%，理由“${r.reason}”`)
        print(`         ${describeReasoning(r.calls.at(-1), agent.model!, agent.reasoningEffort)}`)
      } else {
        add(name, false, r.error ?? '未返回合法 JSON')
      }
    } catch (e) {
      add(name, false, msg(e))
    }
  }

  print(failed ? `自检结束：${failed} 项失败` : '自检结束：全部通过')
  return failed === 0
}

/**
 * 说明最后一次 LLM 请求有没有返回思考过程、用了多少 token。只是提示，不算失败：
 * 不少模型本来就不输出思考过程，也有代理服务不透传 reasoning_content。
 */
export function describeReasoning(call: LlmCall | undefined, model: string, effort: string | null): string {
  if (!call) return '没有请求记录'
  const parts: string[] = []
  const tokens = call.usage?.reasoningTokens
  if (call.reasoning) {
    parts.push(`返回了思考过程（${call.reasoning.length} 字）`)
  } else if (tokens) {
    parts.push('没有返回思考过程的文字，但用量里有思考 token，说明模型思考了、只是服务没有把内容传回来')
  } else {
    parts.push(effort
      ? `没有返回思考过程。设置了思考强度 ${effort}，如果确定模型支持思考，可能是代理服务没有透传 reasoning_content`
      : '没有返回思考过程（模型不输出或服务不透传，不影响使用）')
  }
  if (tokens !== null && tokens !== undefined) parts.push(`思考用了 ${tokens} token`)
  if (call.usage?.totalTokens) parts.push(`本次共 ${call.usage.totalTokens} token`)
  if (call.responseModel && call.responseModel !== model) parts.push(`注意：请求的模型是 ${model}，服务实际返回的是 ${call.responseModel}`)
  return parts.join('；')
}
