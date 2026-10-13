/**
 * 回测：用历史 K 线把同一套策略和风控跑一遍，看看过去一段时间里它会怎么交易、结果如何。
 *
 * 做法：把真实的决策引擎接到模拟交易所和内存数据库上，按 K 线逐根回放——每根 K 线收盘时跑一轮，
 * 现价取这根 K 线的收盘价。这样信号、止损、风控、熔断、去重、手续费记账都和线上是同一套代码。
 *
 * 和线上的差别（看结果时要心里有数）：
 * - 只回测规则策略，不调用 LLM：买入按 100% 交给风控（也就是单笔上限）；线上 LLM 可能否决或调小。
 *   LLM 决策模式没法回测：每根 K 线都要调用一次 LLM，成本太高；模型训练时多半见过这段历史行情，结果也会偏乐观
 * - 每根 K 线只跑一轮，止损只在收盘时检查；线上每个运行间隔检查一次，会更早触发
 * - 按收盘价成交，不考虑滑点；手续费按 0.1%
 *
 * 只调用公开的行情接口（K 线、交易对规则），不下单，也不读写正式数据库。
 */
import Decimal from 'decimal.js'
import type { Config } from './config'
import { Store } from './db'
import { Engine, KLINE_LIMIT } from './engine'
import { BinanceClient, MockExchange, type Kline, type SymbolRules } from './exchange'
import { redact } from './logger'
import { RISK_RULE_LABELS, type RiskRule } from './risk'
import { closedKlines } from './strategy'
import { z } from 'zod'

const MINUTE = 60_000
/** K 线周期对应的毫秒数 */
export const INTERVAL_MS: Record<string, number> = {
  '1m': MINUTE,
  '3m': 3 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': 60 * MINUTE,
  '2h': 120 * MINUTE,
  '4h': 240 * MINUTE,
  '6h': 360 * MINUTE,
  '8h': 480 * MINUTE,
  '12h': 720 * MINUTE,
  '1d': 1440 * MINUTE
}

export interface BacktestTrade {
  time: string
  side: 'buy' | 'sell'
  price: string
  qty: string
  quote: string
  note: string
}

export interface BacktestReport {
  start: string
  end: string
  /** 回放的 K 线根数（不含开头用来计算指标的 KLINE_LIMIT 根） */
  candles: number
  budget: string
  finalEquity: string
  returnPct: string
  benchmarkReturnPct: string
  maxDrawdownPct: string
  trades: BacktestTrade[]
  /** 完整的“买入 → 卖完”次数，及其中赚钱的次数 */
  roundTrips: number
  wins: number
  fees: string
  outcomes: Record<string, number>
  riskBlocks: Record<string, number>
}

const silent = { info: () => {}, warn: () => {}, error: () => {} }

export async function runBacktest({ config, klines, rules }: { config: Config, klines: Kline[], rules: SymbolRules }): Promise<BacktestReport> {
  if (klines.length <= KLINE_LIMIT) throw new Error(`K 线不足：至少需要 ${KLINE_LIMIT + 1} 根，实际 ${klines.length} 根`)

  const exchange = new MockExchange()
  exchange.rules = rules
  exchange.balances = { [rules.quoteAsset]: { free: config.budgetUsdt, locked: new Decimal(0) } }
  const store = new Store(':memory:')
  let now = new Date(0)
  let seq = 0
  const engine = new Engine({ config: () => config, exchange, reviewer: null, decider: null, store, logger: silent, now: () => now, newId: () => `bt-${++seq}` })

  const trades: BacktestTrade[] = []
  const outcomes: Record<string, number> = {}
  const riskBlocks: Record<string, number> = {}
  let tripStartUsdt: Decimal | null = null
  let roundTrips = 0
  let wins = 0

  try {
    for (let i = KLINE_LIMIT; i < klines.length; i++) {
      const k = klines[i]!
      exchange.klines = klines.slice(i - KLINE_LIMIT, i + 1)
      exchange.price = new Decimal(k.close)
      now = new Date(k.closeTime + 1)
      const usdtBefore = store.getLedger()?.usdt ?? config.budgetUsdt

      const r = await engine.runOnce('schedule')
      if (r.status !== 'done') continue
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
      const d = store.getDecision(r.decisionId)!
      if (r.outcome === 'risk_block' && d.riskRule) riskBlocks[d.riskRule] = (riskBlocks[d.riskRule] ?? 0) + 1
      if (r.outcome !== 'filled') continue

      const side = d.orderSide === 'BUY' ? 'buy' : 'sell'
      trades.push({ time: d.createdAt, side, price: d.price!, qty: d.filledQty!, quote: d.filledQuote!, note: d.signalNote ?? '' })
      if (side === 'buy' && !tripStartUsdt) tripStartUsdt = usdtBefore
      if (side === 'sell' && tripStartUsdt && !store.getPosition()) {
        roundTrips++
        if (store.getLedger()!.usdt.gt(tripStartUsdt)) wins++
        tripStartUsdt = null
      }
    }

    const snapshots = store.listSnapshots('')
    let peak = new Decimal(0)
    let maxDrawdown = new Decimal(0)
    for (const s of snapshots) {
      const total = new Decimal(s.total)
      if (total.gt(peak)) peak = total
      if (peak.gt(0)) maxDrawdown = Decimal.max(maxDrawdown, peak.minus(total).div(peak).mul(100))
    }
    const last = snapshots.at(-1)!
    const budget = config.budgetUsdt
    const pct = (v: string) => new Decimal(v).minus(budget).div(budget).mul(100).toFixed(2)
    const fees = exchange.orders.reduce((sum, o) => {
      const fillPrice = o.result.quoteQty.div(o.result.executedQty)
      return o.result.commissions.reduce((s, c) => s.plus(c.asset === rules.baseAsset ? c.amount.mul(fillPrice) : c.amount), sum)
    }, new Decimal(0))

    return {
      start: new Date(klines[KLINE_LIMIT]!.closeTime + 1).toISOString(),
      end: new Date(klines.at(-1)!.closeTime + 1).toISOString(),
      candles: klines.length - KLINE_LIMIT,
      budget: budget.toFixed(),
      finalEquity: new Decimal(last.total).toFixed(2),
      returnPct: pct(last.total),
      benchmarkReturnPct: pct(last.benchmark),
      maxDrawdownPct: maxDrawdown.toFixed(2),
      trades,
      roundTrips,
      wins,
      fees: fees.toFixed(2),
      outcomes,
      riskBlocks
    }
  } finally {
    store.close()
  }
}

interface KlineSource {
  getKlines(symbol: string, interval: string, limit: number, range: { startTime?: number, endTime?: number }): Promise<Kline[]>
}

/** 分页拉取 [startTime, endTime) 内已收盘的 K 线（每次最多 1000 根）。 */
export async function fetchHistory(
  source: KlineSource,
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  onProgress?: (count: number) => void
): Promise<Kline[]> {
  const out: Kline[] = []
  let cursor = startTime
  while (cursor < endTime) {
    const page = await source.getKlines(symbol, interval, 1000, { startTime: cursor, endTime })
    const fresh = page.filter(k => k.openTime >= cursor)
    if (!fresh.length) break
    out.push(...fresh)
    cursor = fresh.at(-1)!.openTime + 1
    onProgress?.(out.length)
    // 不满一页说明已经拉到最新
    if (page.length < 1000) break
  }
  return closedKlines(out, endTime)
}

const MODE_LABELS = { trend: '趋势（trend）', cross: '交叉（cross）' }
const OUTCOME_LABELS: Record<string, string> = {
  hold: '观望',
  filled: '成交',
  risk_block: '风控拦截',
  paused: '熔断暂停',
  unfilled: '未成交',
  error: '出错'
}

/** 把回测结果整理成给人看的几行文字。 */
export function formatReport(config: Config, report: BacktestReport): string[] {
  const s = config.strategy
  const r = config.risk
  const stops = [
    s.stopLossPct > 0 ? `止损 ${s.stopLossPct}%` : '止损关闭',
    s.trailingStopPct > 0 ? `移动止损 ${s.trailingStopPct}%` : '移动止损关闭'
  ].join('，')
  const lines = [
    `回测：${config.symbol}，${s.klineInterval} K 线，${report.start.slice(0, 16)} ~ ${report.end.slice(0, 16)}（UTC），共 ${report.candles} 根`,
    `参数：${MODE_LABELS[s.mode]}模式${s.mode === 'trend' ? `（连续 ${s.confirmBars} 根确认）` : ''}，SMA${s.smaFast}/${s.smaSlow}，RSI${s.rsiPeriod} 买入上限 ${s.rsiBuyMax} / 止盈 ${s.rsiSellMin >= 100 ? '关闭' : s.rsiSellMin}，${stops}`,
    `风控：预算 ${report.budget} USDT，单笔上限 ${r.maxOrderUsdt.toFixed()} USDT，仓位上限 ${r.maxPositionPct}%，每日 ${r.maxTradesPerDay} 笔，冷却 ${r.cooldownMinutes} 分钟，熔断 ${r.dailyLossLimitPct}%`,
    '说明：不调用 LLM（买入按单笔上限），每根 K 线收盘时跑一轮，按收盘价成交，手续费 0.1%',
    '',
    `期末资产：${report.finalEquity} USDT`,
    `策略收益率：${report.returnPct}%`,
    `同期一直持有：${report.benchmarkReturnPct}%`,
    `最大回撤：${report.maxDrawdownPct}%`,
    `成交：${report.trades.length} 笔，完整买卖 ${report.roundTrips} 次，其中盈利 ${report.wins} 次，手续费约 ${report.fees} USDT`,
    `每轮结果：${Object.entries(report.outcomes).map(([k, v]) => `${OUTCOME_LABELS[k] ?? k} ${v}`).join('，')}`
  ]
  const blocks = Object.entries(report.riskBlocks)
  if (blocks.length) {
    lines.push(`风控拦截原因：${blocks.map(([k, v]) => `${RISK_RULE_LABELS[k as RiskRule] ?? k} ${v}`).join('，')}`)
  }
  if (report.trades.length) {
    lines.push('', '成交明细（UTC）：')
    for (const t of report.trades) {
      lines.push(`  ${t.time.slice(0, 16)} ${t.side === 'buy' ? '买入' : '卖出'} ${t.qty} @ ${new Decimal(t.price).toFixed(2)}，${new Decimal(t.quote).toFixed(2)} USDT · ${t.note.replace(/（SMA.*$/, '')}`)
    }
  }
  return lines
}

/** 回测天数：BACKTEST_DAYS，默认 90，1~1000。 */
export function parseBacktestDays(value: string | undefined): number {
  const r = z.coerce.number().int().min(1).max(1000).safeParse(value?.trim() || 90)
  if (!r.success) throw new Error('BACKTEST_DAYS 必须是 1~1000 之间的整数')
  return r.data
}

/** BACKTEST=1 时由启动插件调用：拉取历史 K 线、回测并打印结果。成功返回 true。 */
export async function runBacktestCommand(config: Config, days: number, print: (line: string) => void): Promise<boolean> {
  if (config.decision.mode === 'llm') {
    print('面板当前是 LLM 决策模式。LLM 决策没法回测，下面按面板里规则策略的参数回测，供对比参考')
    config = { ...config, decision: { ...config.decision, mode: 'rules' } }
  }
  try {
    const client = new BinanceClient({ baseUrl: config.binance.baseUrl, apiKey: config.binance.apiKey, apiSecret: config.binance.apiSecret })
    const interval = config.strategy.klineInterval
    const step = INTERVAL_MS[interval]!
    const end = Date.now()
    // 多取 KLINE_LIMIT 根，作为第一轮计算指标用的历史
    const start = end - (Math.ceil(days * 86_400_000 / step) + KLINE_LIMIT + 1) * step
    print(`正在从 ${config.binance.baseUrl} 获取 ${config.symbol} 最近 ${days} 天的 ${interval} K 线…`)
    const rules = await client.getSymbolRules(config.symbol)
    const klines = await fetchHistory(client, config.symbol, interval, start, end)
    print(`已获取 ${klines.length} 根 K 线，开始回测`)
    if (klines.length <= KLINE_LIMIT) {
      throw new Error(`历史 K 线只有 ${klines.length} 根，不够回测（至少 ${KLINE_LIMIT + 1} 根）。测试网只保留最近一小段数据，建议用 Demo Mode 回测`)
    }
    const report = await runBacktest({ config, klines, rules })
    print('')
    for (const line of formatReport(config, report)) print(line)
    return true
  } catch (e) {
    print(`回测失败：${redact((e as Error).message)}`)
    return false
  }
}
