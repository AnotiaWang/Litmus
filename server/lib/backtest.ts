/**
 * 回测：用历史 K 线把均线基线在当前赛季配置下跑一遍，看看过去一段时间里它会怎么交易、结果如何。
 *
 * 做法：把真实的决策引擎接到模拟行情和内存数据库上，按 K 线逐根回放——每根 K 线收盘时跑一轮，
 * 现价取这根 K 线的收盘价。这样信号、止损、风控、熔断、去重、手续费记账都和线上是同一套代码。
 *
 * 只回测均线基线：LLM 模型每根 K 线都要调用一次，成本太高；模型训练时多半见过这段历史行情，结果也会偏乐观。
 * 和线上的差别：每根 K 线只跑一轮，止损只在收盘时检查（线上每个运行间隔检查一次，会更早触发）。
 *
 * 只调用公开的行情接口，不读写正式数据库。
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import Decimal from 'decimal.js'
import { z } from 'zod'
import { BASELINE_COLOR } from '../../shared/agents'
import { INTERVAL_MS, RISK_PRESET_LABELS, seasonConfigFieldsSchema, type SeasonConfig } from '../../shared/settings'
import { Store } from './db'
import { Engine, KLINE_LIMIT } from './engine'
import { equityOf } from './ledger'
import { redact } from './logger'
import { BinanceMarket, MockMarket, type Kline, type SymbolRules } from './market'
import { RISK_RULE_LABELS, type RiskRule } from './risk'
import { BASELINE_PARAMS, closedKlines } from './strategy'

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
  capital: string
  finalEquity: string
  returnPct: string
  benchmarkReturnPct: string
  maxDrawdownPct: string
  trades: BacktestTrade[]
  /** 卖出笔数及其中盈利的笔数 */
  sells: number
  wins: number
  fees: string
  outcomes: Record<string, number>
  riskBlocks: Record<string, number>
}

const silent = { info: () => {}, warn: () => {}, error: () => {} }

export async function runBacktest({ config, klines, rules }: { config: SeasonConfig, klines: Kline[], rules: SymbolRules }): Promise<BacktestReport> {
  if (klines.length <= KLINE_LIMIT) throw new Error(`K 线不足：至少需要 ${KLINE_LIMIT + 1} 根，实际 ${klines.length} 根`)

  const market = new MockMarket()
  market.rules = rules
  const store = new Store(':memory:')
  let now = new Date(klines[KLINE_LIMIT]!.closeTime)
  let seq = 0
  const agentId = store.insertAgent({ kind: 'baseline', name: '均线基线', color: BASELINE_COLOR }, now)
  const season = store.startSeason('回测', config, now)
  const engine = new Engine({
    store,
    market,
    deciderFor: () => {
      throw new Error('回测不调用 LLM')
    },
    logger: silent,
    now: () => now,
    newId: () => `bt-${++seq}`
  })

  const trades: BacktestTrade[] = []
  const outcomes: Record<string, number> = {}
  const riskBlocks: Record<string, number> = {}
  let sells = 0
  let wins = 0
  let fees = new Decimal(0)
  let peak = new Decimal(0)
  let maxDrawdown = new Decimal(0)
  const capital = new Decimal(config.initialCapital)
  const state = store.entry(season.id, agentId)

  try {
    for (let i = KLINE_LIMIT; i < klines.length; i++) {
      const k = klines[i]!
      market.klines = klines.slice(i - KLINE_LIMIT, i + 1)
      market.price = new Decimal(k.close)
      now = new Date(k.closeTime + 1)

      const r = await engine.runOnce('schedule')
      if (r.status !== 'done') continue
      const equity = equityOf(state.getLedger()!, market.price)
      if (equity.gt(peak)) peak = equity
      if (peak.gt(0)) maxDrawdown = Decimal.max(maxDrawdown, peak.minus(equity).div(peak).mul(100))

      const o = r.outcomes[0]
      if (!o) continue
      outcomes[o.outcome] = (outcomes[o.outcome] ?? 0) + 1
      if (!o.decisionId) continue
      const d = store.getDecision(o.decisionId)!
      if (o.outcome === 'risk_block' && d.riskRule) riskBlocks[d.riskRule] = (riskBlocks[d.riskRule] ?? 0) + 1
      if (o.outcome !== 'filled') continue
      trades.push({ time: d.createdAt, side: d.orderSide!, price: d.price, qty: d.filledQty!, quote: d.filledQuote!, note: d.signalNote ?? '' })
      fees = fees.plus(d.feeUsdt!)
      if (d.orderSide === 'sell') {
        sells++
        if (new Decimal(d.realizedPnl!).gt(0)) wins++
      }
    }

    const final = equityOf(state.getLedger()!, new Decimal(klines.at(-1)!.close))
    const startPrice = new Decimal(state.getInitial()!.price)
    const pct = (v: Decimal) => v.minus(capital).div(capital).mul(100).toFixed(2)
    return {
      start: new Date(klines[KLINE_LIMIT]!.closeTime + 1).toISOString(),
      end: new Date(klines.at(-1)!.closeTime + 1).toISOString(),
      candles: klines.length - KLINE_LIMIT,
      capital: capital.toFixed(),
      finalEquity: final.toFixed(2),
      returnPct: pct(final),
      benchmarkReturnPct: new Decimal(klines.at(-1)!.close).minus(startPrice).div(startPrice).mul(100).toFixed(2),
      maxDrawdownPct: maxDrawdown.toFixed(2),
      trades,
      sells,
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

const OUTCOME_LABELS: Record<string, string> = {
  hold: '观望',
  filled: '成交',
  risk_block: '风控拦截',
  paused: '暂停',
  error: '出错'
}

/** 把回测结果整理成给人看的几行文字。 */
export function formatReport(config: SeasonConfig, report: BacktestReport): string[] {
  const r = config.risk
  const p = BASELINE_PARAMS
  const stops = [
    r.stopLossPct > 0 ? `止损 ${r.stopLossPct}%` : '止损关闭',
    r.trailingStopPct > 0 ? `移动止损 ${r.trailingStopPct}%` : '移动止损关闭'
  ].join('，')
  const lines = [
    `回测：${config.symbol}，${config.klineInterval} K 线，${report.start.slice(0, 16)} ~ ${report.end.slice(0, 16)}（UTC），共 ${report.candles} 根`,
    `均线基线：SMA${p.smaFast}/${p.smaSlow} 连续 ${p.confirmBars} 根确认，RSI${p.rsiPeriod} 买入上限 ${p.rsiBuyMax}`,
    `风控（${RISK_PRESET_LABELS[config.riskPreset]}）：初始资金 ${report.capital} USDT，${stops}，单笔上限 ${r.maxOrderPct}%，仓位上限 ${r.maxPositionPct}%，每日 ${r.maxTradesPerDay} 笔，冷却 ${r.cooldownMinutes} 分钟，熔断 ${r.dailyLossLimitPct}%`,
    '说明：每根 K 线收盘时跑一轮，按收盘价成交，手续费 0.1%',
    '',
    `期末资产：${report.finalEquity} USDT`,
    `收益率：${report.returnPct}%`,
    `同期一直持有：${report.benchmarkReturnPct}%`,
    `最大回撤：${report.maxDrawdownPct}%`,
    `成交：${report.trades.length} 笔，其中卖出 ${report.sells} 笔、盈利 ${report.wins} 笔，手续费 ${report.fees} USDT`,
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

/** 只读地取出数据库里当前赛季的配置（回测用，不改动正式数据库）；数据库不存在或没有赛季时返回 null。 */
export function readCurrentSeasonConfig(path: string): SeasonConfig | null {
  if (!existsSync(path)) return null
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasSeasons = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seasons'`).get()
    const row = hasSeasons ? db.prepare('SELECT config FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as { config: string } | undefined : undefined
    return row ? seasonConfigFieldsSchema.parse(JSON.parse(row.config)) : null
  } finally {
    db.close()
  }
}

/** BACKTEST=1 时由启动插件调用：拉取历史 K 线、回测并打印结果。成功返回 true。 */
export async function runBacktestCommand(config: SeasonConfig, days: number, print: (line: string) => void): Promise<boolean> {
  try {
    const market = new BinanceMarket()
    const interval = config.klineInterval
    const step = INTERVAL_MS[interval]
    const end = Date.now()
    // 多取 KLINE_LIMIT 根，作为第一轮计算指标用的历史
    const start = end - (Math.ceil(days * 86_400_000 / step) + KLINE_LIMIT + 1) * step
    print(`正在获取 ${config.symbol} 最近 ${days} 天的 ${interval} K 线…`)
    const rules = await market.getSymbolRules(config.symbol)
    const klines = await fetchHistory(market, config.symbol, interval, start, end)
    print(`已获取 ${klines.length} 根 K 线，开始回测`)
    const report = await runBacktest({ config, klines, rules })
    print('')
    for (const line of formatReport(config, report)) print(line)
    return true
  } catch (e) {
    print(`回测失败：${redact((e as Error).message)}`)
    return false
  }
}
