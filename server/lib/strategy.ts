/**
 * 规则策略：用均线 + RSI 产生买 / 卖 / 观望信号，再加上按持仓成本的止损（止损检查 LLM 决策模式也用）。
 *
 * 这是教学用的简单策略，目的是让整条流水线有一个可解释的起点，而不是追求收益。
 * - SMA（简单移动平均）：最近 N 根 K 线收盘价的平均值。短期均线在长期均线上方通常被看作趋势向上。
 * - RSI（相对强弱指数，0~100）：衡量近期涨跌力度。数值很高说明短期涨得很猛，可能“过热”。
 *
 * 两种模式（SIGNAL_MODE）：
 * - trend（默认）：看均线当前所处的状态。空仓且短期均线在上方、RSI 未过热就买；持仓且短期均线跌到下方就卖。
 *   不依赖“恰好在交叉那根 K 线上”，服务中途停过也不会错过。
 *   均线在交叉附近常常来回穿越，所以要连续 confirmBars 根 K 线都在上方 / 下方才算数，减少来回买卖。
 * - cross：只在均线交叉的那根 K 线上买卖（金叉买、死叉卖），信号少，错过就没有了。
 *
 * 两种模式共用：只在空仓时买（不加仓），只在持仓时卖；持仓时 RSI 过高止盈；价格跌破止损线立即卖出。
 * 止损按当前价判断（每轮都检查），其余信号只使用已经收盘的 K 线，避免同一轮里信号来回跳。
 * 指标是统计量而非金额，所以这里用普通 number 计算即可。
 */
import type { Kline } from './exchange'

export type Signal = 'buy' | 'sell' | 'hold'

export interface StrategyParams {
  smaFast: number
  smaSlow: number
  rsiPeriod: number
  /** 满足买入条件时 RSI 还必须低于此值才买（默认 70） */
  rsiBuyMax: number
  /** 持仓时 RSI 高于此值就卖；100 为关闭（默认） */
  rsiSellMin: number
  mode: 'trend' | 'cross'
  /** trend 模式：短期均线要连续这么多根 K 线都在长期均线上方 / 下方才买 / 卖，1 为不确认 */
  confirmBars: number
  /** 价格低于持仓均价这么多 % 时止损，0 为关闭 */
  stopLossPct: number
  /** 价格低于持仓以来最高价这么多 % 时止损，0 为关闭 */
  trailingStopPct: number
}

/** 持仓状况，由引擎根据策略账本算好传进来 */
export interface PositionContext {
  /** 账本持币市值是否达到交易所最小下单额（卖不掉的零头不算持仓） */
  hasPosition: boolean
  /** 当前价 */
  price: number
  /** 持仓均价（含买入手续费）；未持仓时为 null */
  entryPrice: number | null
  /** 持仓以来的最高价；未持仓时为 null */
  peakPrice: number | null
  /** 止损或止盈卖出后，trend 模式要等短期均线先回到长期均线下方，才允许再次买入，避免卖出后马上又买回去 */
  reentryLocked: boolean
}

export interface Indicators {
  close: number
  smaFast: number
  smaSlow: number
  prevSmaFast: number
  prevSmaSlow: number
  rsi: number
}

/** 信号的具体来源，引擎据此区分止损卖出（止损后要锁定再次买入） */
export type SignalKind
  = | 'stop_loss'
    | 'trailing_stop'
    | 'take_profit'
    | 'trend_down'
    | 'death_cross'
    | 'trend_up'
    | 'golden_cross'
    | 'none'

export interface StrategyResult {
  signal: Signal
  kind: SignalKind
  indicators: Indicators
  /** 信号说明，末尾附带指标数值 */
  note: string
  /** 信号说明，不带指标数值（交给 LLM 时指标另外列出） */
  reason: string
}

/** 给 LLM 看的行情摘要，由程序算好，免得它在一长串 K 线上心算 */
export interface MarketStats {
  /** 统计区间：最近 24 小时，K 线不够 24 小时就取全部；hours 为实际覆盖的小时数 */
  hours: number
  changePct: number
  high: number
  low: number
  /** 平均真实波幅（Wilder 平滑，14 根），数据不足时为 NaN */
  atr: number
  /** 最新一根成交量 ÷ 之前 20 根的平均成交量，数据不足时为 NaN */
  volumeRatio: number
}

/** 最近 period 个值的简单平均；数据不足时返回 NaN。 */
export function sma(values: number[], period: number): number {
  if (values.length < period) return Number.NaN
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!
  return sum / period
}

/**
 * RSI，采用 Wilder 平滑法（最常见的算法，和大多数看盘软件一致）：
 * 先用前 period 次涨跌的简单平均作为起点，之后每根 K 线按 (前值 × (period-1) + 本次) / period 平滑。
 */
export function rsi(values: number[], period: number): number {
  if (values.length < period + 1) return Number.NaN
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!
    if (d > 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/** ATR（平均真实波幅），和 RSI 一样用 Wilder 平滑；数据不足时返回 NaN。 */
export function atr(klines: Kline[], period: number): number {
  if (klines.length < period + 1) return Number.NaN
  const tr = klines.slice(1).map((k, i) => {
    const high = Number(k.high)
    const low = Number(k.low)
    const prevClose = Number(klines[i]!.close)
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
  })
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]!) / period
  return value
}

export function indicatorsOf(closes: number[], params: Pick<StrategyParams, 'smaFast' | 'smaSlow' | 'rsiPeriod'>): Indicators {
  const prev = closes.slice(0, -1)
  return {
    close: closes.at(-1)!,
    smaFast: sma(closes, params.smaFast),
    smaSlow: sma(closes, params.smaSlow),
    prevSmaFast: sma(prev, params.smaFast),
    prevSmaSlow: sma(prev, params.smaSlow),
    rsi: rsi(closes, params.rsiPeriod)
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const VOLUME_BARS = 20

/** 根据已收盘 K 线（按时间先后）算行情摘要。 */
export function marketStats(klines: Kline[]): MarketStats {
  const last = klines.at(-1)!
  const end = last.closeTime + 1
  const window = klines.filter(k => k.openTime >= end - DAY_MS)
  const first = window[0]!
  const close = Number(last.close)
  const open = Number(first.open)
  const prevVolumes = klines.slice(-VOLUME_BARS - 1, -1).map(k => Number(k.volume))
  const avgVolume = prevVolumes.reduce((a, b) => a + b, 0) / prevVolumes.length
  return {
    hours: (end - first.openTime) / 3_600_000,
    changePct: (close - open) / open * 100,
    high: Math.max(...window.map(k => Number(k.high))),
    low: Math.min(...window.map(k => Number(k.low))),
    atr: atr(klines, 14),
    volumeRatio: prevVolumes.length === VOLUME_BARS && avgVolume > 0 ? Number(last.volume) / avgVolume : Number.NaN
  }
}

/**
 * 从最新一根往前数，短期均线连续在长期均线上方（dir = 1）或下方（dir = -1）的根数，数到 limit 为止。
 */
export function streak(closes: number[], params: Pick<StrategyParams, 'smaFast' | 'smaSlow'>, dir: 1 | -1, limit: number): number {
  let n = 0
  while (n < limit) {
    const c = closes.slice(0, closes.length - n)
    const fast = sma(c, params.smaFast)
    const slow = sma(c, params.smaSlow)
    if (!(dir === 1 ? fast > slow : fast < slow)) break
    n++
  }
  return n
}

/** 只保留在 now 之前已经收盘的 K 线。 */
export function closedKlines(klines: Kline[], now: number): Kline[] {
  return klines.filter(k => k.closeTime < now)
}

const fmt = (n: number) => n.toFixed(2)

/** 止损线：取止损和移动止损里较高（更早触发）的那条；都没开或未持仓时为 null。 */
export function stopLine(params: Pick<StrategyParams, 'stopLossPct' | 'trailingStopPct'>, entryPrice: number | null, peakPrice: number | null): { price: number, kind: 'stop_loss' | 'trailing_stop' } | null {
  const lines: Array<{ price: number, kind: 'stop_loss' | 'trailing_stop' }> = []
  if (params.stopLossPct > 0 && entryPrice) lines.push({ price: entryPrice * (1 - params.stopLossPct / 100), kind: 'stop_loss' })
  if (params.trailingStopPct > 0 && peakPrice) lines.push({ price: peakPrice * (1 - params.trailingStopPct / 100), kind: 'trailing_stop' })
  return lines.sort((a, b) => b.price - a.price)[0] ?? null
}

/** 持仓且现价跌破止损线时返回止损类型和说明，否则为 null。两种决策模式共用。 */
export function checkStop(params: Pick<StrategyParams, 'stopLossPct' | 'trailingStopPct'>, pos: Omit<PositionContext, 'reentryLocked'>): { kind: 'stop_loss' | 'trailing_stop', note: string } | null {
  if (!pos.hasPosition) return null
  const stop = stopLine(params, pos.entryPrice, pos.peakPrice)
  if (!stop || pos.price > stop.price) return null
  return stop.kind === 'stop_loss'
    ? { kind: 'stop_loss', note: `止损：现价 ${fmt(pos.price)} 跌破止损线 ${fmt(stop.price)}（持仓均价 ${fmt(pos.entryPrice!)} 下方 ${params.stopLossPct}%）` }
    : { kind: 'trailing_stop', note: `移动止损：现价 ${fmt(pos.price)} 跌破止损线 ${fmt(stop.price)}（持仓以来最高价 ${fmt(pos.peakPrice!)} 下方 ${params.trailingStopPct}%）` }
}

/**
 * 根据已收盘 K 线和当前持仓给出信号。判断顺序：止损 → 卖出条件 → 买入条件 → 观望。
 */
export function evaluate(klines: Kline[], params: StrategyParams, pos: PositionContext): StrategyResult {
  const closes = klines.map(k => Number(k.close))
  // cross 模式要用到前一根；trend 模式往前数 confirmBars 根，每根都要算长期均线
  const need = params.smaSlow + Math.max(1, params.mode === 'trend' ? params.confirmBars - 1 : 1)
  if (closes.length < need) {
    throw new Error(`K 线数量不足：需要至少 ${need} 根已收盘 K 线，实际 ${closes.length} 根`)
  }
  const indicators = indicatorsOf(closes, params)
  const { smaFast, smaSlow, prevSmaFast, prevSmaSlow, rsi: r } = indicators
  const up = smaFast > smaSlow
  const down = smaFast < smaSlow
  // trend 模式的买卖要连续 confirmBars 根成立；只在需要时往前数
  const confirm = params.mode === 'trend' ? params.confirmBars : 1
  const confirmText = confirm > 1 ? `连续 ${confirm} 根` : ''
  const crossUp = prevSmaFast <= prevSmaSlow && up
  const crossDown = prevSmaFast >= prevSmaSlow && smaFast < smaSlow
  const maText = `SMA${params.smaFast}=${fmt(smaFast)}，SMA${params.smaSlow}=${fmt(smaSlow)}，RSI${params.rsiPeriod}=${fmt(r)}`
  const result = (signal: Signal, kind: SignalKind, reason: string): StrategyResult => ({ signal, kind, indicators, note: `${reason}（${maText}）`, reason })

  if (pos.hasPosition) {
    const stop = checkStop(params, pos)
    if (stop) return result('sell', stop.kind, stop.note)
    if (params.mode === 'cross' && crossDown) {
      return result('sell', 'death_cross', '死叉：短期均线下穿长期均线')
    }
    const downBars = params.mode === 'trend' && down ? streak(closes, params, -1, confirm) : 0
    if (downBars >= confirm) {
      return result('sell', 'trend_down', `趋势转弱：短期均线${confirmText}在长期均线下方`)
    }
    if (r > params.rsiSellMin) {
      return result('sell', 'take_profit', `持仓中且 RSI 高于 ${params.rsiSellMin}，短期过热，止盈`)
    }
    if (downBars > 0) {
      return result('hold', 'none', `持仓中，短期均线跌到长期均线下方 ${downBars} 根，需连续 ${confirm} 根才卖出`)
    }
    return result('hold', 'none', '持仓中，没有卖出信号')
  }

  const buySignal = params.mode === 'trend' ? up : crossUp
  if (!buySignal) {
    if (params.mode === 'cross' && crossDown) return result('hold', 'none', '出现死叉，但没有持仓，观望')
    return result('hold', 'none', params.mode === 'trend' ? '空仓，短期均线不在长期均线上方，观望' : '空仓，没有金叉，观望')
  }
  if (params.mode === 'trend' && pos.reentryLocked) {
    return result('hold', 'none', '止损 / 止盈卖出后等待趋势重新确认：短期均线需先回到长期均线下方，之后再上穿才会买入')
  }
  if (params.mode === 'trend' && confirm > 1) {
    const upBars = streak(closes, params, 1, confirm)
    if (upBars < confirm) {
      return result('hold', 'none', `空仓，短期均线在长期均线上方 ${upBars} 根，需连续 ${confirm} 根才买入`)
    }
  }
  const what = params.mode === 'trend' ? `短期均线${confirmText}在长期均线上方` : '金叉：短期均线上穿长期均线'
  if (r >= params.rsiBuyMax) {
    return result('hold', 'none', `${what}，但 RSI 不低于 ${params.rsiBuyMax}，短期过热，等回落再买`)
  }
  return result('buy', params.mode === 'trend' ? 'trend_up' : 'golden_cross', `${what}，且 RSI 低于 ${params.rsiBuyMax}`)
}
