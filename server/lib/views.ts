/**
 * 接口返回的数据组装。接口层（server/api）只负责解析参数、调用这里。
 *
 * 金额以字符串返回，保留完整精度，由前端负责格式化显示。
 * 这里返回的内容不包含任何 Key 或口令。
 */
import Decimal from 'decimal.js'
import type { AccountResponse, DecisionSummary, EquityResponse, StatusResponse } from '../../shared/types/api'
import type { Config } from './config'
import type { Decision, Store } from './db'
import { cadenceText, type Engine } from './engine'
import { stopLine } from './strategy'

export interface ViewDeps {
  /** 取当前生效的配置 */
  config: () => Config
  store: Store
  engine: Engine
  nextRunAt: string | null
}

export function statusView({ store, engine, nextRunAt, ...deps }: ViewDeps): StatusResponse {
  const config = deps.config()
  const pause = store.getPause()
  return {
    running: engine.isRunning,
    paused: pause.paused,
    pauseReason: pause.reason,
    pauseSource: pause.source,
    pausedUntil: pause.until,
    mode: config.binance.env,
    symbol: config.symbol,
    intervalMinutes: config.intervalMinutes,
    decisionMode: config.decision.mode,
    llmCadence: config.decision.mode === 'llm' ? cadenceText(config.decision, config.strategy.klineInterval) : null,
    llmEnabled: config.llm.enabled,
    strategy: {
      klineInterval: config.strategy.klineInterval,
      smaFast: config.strategy.smaFast,
      smaSlow: config.strategy.smaSlow,
      rsiPeriod: config.strategy.rsiPeriod
    },
    nextRunAt,
    lastRunAt: store.lastDecisionAt()
  }
}

const pct = (value: Decimal, base: Decimal) => base.gt(0) ? value.minus(base).div(base).mul(100).toFixed(2) : '0.00'

export function accountView({ store, ...deps }: Pick<ViewDeps, 'config' | 'store'>): AccountResponse {
  const config = deps.config()
  const snap = store.latestSnapshot()
  const initial = store.getInitial()
  const baseAsset = config.symbol.replace(/USDT$/, '')
  if (!snap || !initial) {
    return { ready: false, baseAsset, budget: config.budgetUsdt.toFixed() }
  }
  const budget = new Decimal(initial.budget)
  const total = new Decimal(snap.total)
  // 引擎每轮会在只剩零头时清掉持仓记录，所以有记录就表示持仓中
  const position = store.getPosition()
  const base = new Decimal(snap.base)
  const holding = position && base.gt(0)
  const entryPrice = holding ? position.cost.div(base) : null
  const stop = holding ? stopLine(config.strategy, entryPrice!.toNumber(), position.peak.toNumber()) : null
  const benchmark = new Decimal(snap.benchmark)
  const returnPct = pct(total, budget)
  const benchmarkReturnPct = pct(benchmark, budget)
  return {
    ready: true,
    asOf: snap.createdAt,
    baseAsset,
    budget: initial.budget,
    initialPrice: initial.price,
    startedAt: initial.at,
    price: snap.price,
    usdt: snap.usdt,
    base: snap.base,
    positionValue: base.mul(snap.price).toFixed(),
    entryPrice: entryPrice?.toFixed() ?? null,
    // 止损线按 number 计算，取 12 位有效数字去掉浮点尾差
    stopPrice: stop ? new Decimal(stop.price).toSignificantDigits(12).toFixed() : null,
    total: snap.total,
    returnPct,
    benchmark: snap.benchmark,
    benchmarkReturnPct,
    excessReturnPct: new Decimal(returnPct).minus(benchmarkReturnPct).toFixed(2)
  }
}

/**
 * 资产曲线。只画当前这一期账本（修改预算后重新开始，之前的快照按旧预算计算，放在一起没法比）。
 * 点数过多时等间隔抽样，保留最后一个点。
 */
export function equityView(store: Store, days: number, now = new Date(), maxPoints = 1500): EquityResponse {
  const runIntervalMs = store.getSettings().intervalMinutes * 60_000
  const initial = store.getInitial()
  if (!initial) return { points: [], intervalMs: runIntervalMs }
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const all = store.listSnapshots(since > initial.at ? since : initial.at)
  const step = Math.max(1, Math.ceil(all.length / maxPoints))
  const points = all.filter((_, i) => i % step === 0 || i === all.length - 1)
  return {
    points: points.map(s => ({ t: s.createdAt, total: s.total, benchmark: s.benchmark, price: s.price })),
    intervalMs: runIntervalMs * step
  }
}

/** 列表里不带 LLM 原始返回和调用详情（可能较长），详情接口再给。 */
export function decisionSummary(d: Decision): DecisionSummary {
  const { llmRaw: _raw, llmCalls: _calls, llmPrompt: _prompt, ...rest } = d
  return rest
}
