/**
 * 部署后自检：`docker compose run --rm -e SELFCHECK=1 app`
 *
 * 依次检查网络、时间同步、交易对、API Key、账户余额、LLM，逐项输出结果。
 * 只做查询，不下单。前一项失败时，依赖它的后续项会标记为跳过。
 */
import type { Config } from './config'
import type { Exchange, Kline } from './exchange'
import type { LlmCall } from '../../shared/types/api'
import type { Reviewer } from './llm'
import { evaluate, marketStats } from './strategy'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfcheckDeps {
  config: Config
  exchange: Exchange
  reviewer: Reviewer | null
}

const MAX_CLOCK_SKEW_MS = 1000

export async function runSelfcheck(deps: SelfcheckDeps, print: (line: string) => void = console.log): Promise<boolean> {
  const { config, exchange, reviewer } = deps
  const results: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail })
    print(`${ok ? '✅ 通过' : '❌ 失败'}  ${name}：${detail}`)
  }
  const msg = (e: unknown) => (e as Error).message

  print(`自检开始：交易所 ${config.binance.baseUrl}（${config.binance.env === 'demo' ? 'Demo Mode' : '测试网'}），交易对 ${config.symbol}`)

  let offset: number | null = null
  try {
    offset = await exchange.syncTime()
    add('网络连通', true, '能访问交易所接口')
  } catch (e) {
    add('网络连通', false, msg(e))
  }

  if (offset === null) {
    add('时间同步', false, '跳过（网络不通）')
  } else if (Math.abs(offset) <= MAX_CLOCK_SKEW_MS) {
    add('时间同步', true, `本机与交易所相差 ${offset} 毫秒`)
  } else {
    add('时间同步', false, `本机与交易所相差 ${offset} 毫秒，超过 ${MAX_CLOCK_SKEW_MS} 毫秒。程序会自动校准，但建议开启服务器 NTP 时间同步`)
  }

  let klines: Kline[] = []
  let minNotional = '0'
  try {
    const rules = await exchange.getSymbolRules(config.symbol)
    minNotional = rules.minNotional.toFixed()
    klines = await exchange.getKlines(config.symbol, config.strategy.klineInterval, 100)
    add('交易对与行情', true, `${rules.baseAsset}/${rules.quoteAsset}，最小下单额 ${rules.minNotional.toFixed()} ${rules.quoteAsset}，获取到 ${klines.length} 根 K 线`)
  } catch (e) {
    add('交易对与行情', false, msg(e))
  }

  try {
    const balances = await exchange.getBalances()
    add('API Key', true, '签名请求成功，Key 有效')
    const usdt = balances.USDT?.free
    if (usdt && usdt.gte(config.budgetUsdt)) {
      add('账户余额', true, `可用 ${usdt.toFixed(2)} USDT，不少于预算 ${config.budgetUsdt.toFixed()} USDT`)
    } else {
      add('账户余额', false, `可用 ${usdt?.toFixed(2) ?? '0'} USDT，少于预算 ${config.budgetUsdt.toFixed()} USDT`)
    }
  } catch (e) {
    add('API Key', false, msg(e))
    add('账户余额', false, '跳过（Key 无效）')
  }

  if (!reviewer) {
    add('LLM', true, '没有配置 LLM 连接信息，不使用 LLM，跳过')
  } else {
    try {
      const closed = klines.slice(0, -1)
      if (closed.length < config.strategy.smaSlow + 1) throw new Error('没有足够的 K 线构造测试输入（上一项失败）')
      const s = evaluate(closed, config.strategy, { hasPosition: false, price: Number(closed.at(-1)!.close), entryPrice: null, peakPrice: null, reentryLocked: false })
      const started = Date.now()
      const review = await reviewer.review({
        symbol: config.symbol,
        signalNote: '（自检用的模拟信号，请照常复核）',
        now: new Date().toISOString(),
        price: closed.at(-1)!.close,
        klineInterval: config.strategy.klineInterval,
        klines: closed.slice(-24),
        indicators: s.indicators,
        periods: config.strategy,
        stats: marketStats(closed),
        ledger: { usdt: config.budgetUsdt.toFixed(), base: '0', baseAsset: config.symbol.replace(/USDT$/, '') },
        stopRules: config.strategy,
        limits: { maxOrderUsdt: config.risk.maxOrderUsdt.toFixed(), minOrderUsdt: minNotional, maxPositionPct: config.risk.maxPositionPct },
        recentDecisions: []
      })
      if (review.valid) {
        const seconds = ((Date.now() - started) / 1000).toFixed(1)
        const effort = config.llm.reasoningEffort ? `，思考强度 ${config.llm.reasoningEffort}` : ''
        const off = config.decision.mode === 'llm' || config.llm.enabled ? '' : '（面板里目前关闭了 LLM 复核，开启复核或切换到 LLM 决策模式后才会用到）'
        add('LLM', true, `返回合法 JSON（耗时 ${seconds} 秒，超时上限 ${config.llm.timeoutMs / 1000} 秒${effort}）：${review.decision}，比例 ${review.sizePct}%，理由“${review.reason}”${off}`)
        add('LLM 思考过程', true, describeReasoning(review.calls.at(-1), config.llm.model, config.llm.reasoningEffort))
      } else {
        add('LLM', false, review.error ?? '未返回合法 JSON')
      }
    } catch (e) {
      add('LLM', false, msg(e))
    }
  }

  const failed = results.filter(r => !r.ok).length
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
