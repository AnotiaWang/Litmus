/** 测试共用：构造赛季配置、K 线和完整的模拟环境。 */
import Decimal from 'decimal.js'
import { BASELINE_COLOR } from '../../shared/agents'
import { seasonConfigSchema, type RiskParams, type SeasonConfig } from '../../shared/settings'
import { Store } from '../../server/lib/db'
import { Engine } from '../../server/lib/engine'
import { MockLlm } from '../../server/lib/llm'
import { MockMarket, type Kline } from '../../server/lib/market'
import { BASELINE_PARAMS, type StrategyParams } from '../../server/lib/strategy'

export const ADMIN_TOKEN = 'admin-token-0123456789'
export const PROVIDER_KEY = 'test-llm-key-CCCC-0123'

/**
 * 测试默认的风控参数（和旧版本的默认值一致）：止损 5%，单笔最多总资产的 50%，仓位上限 50%，
 * 每天 6 笔，冷却 60 分钟，熔断 5%。用例里需要别的值时单独覆盖。
 */
export const FIXTURE_RISK: RiskParams = { stopLossPct: 5, trailingStopPct: 0, maxOrderPct: 50, maxPositionPct: 50, maxTradesPerDay: 6, cooldownMinutes: 60, dailyLossLimitPct: 5 }

export type ConfigOverrides = Partial<Omit<SeasonConfig, 'risk'>> & { risk?: Partial<RiskParams> }

/** 测试用的赛季配置：初始资金 100 USDT，自定义风控（FIXTURE_RISK） */
export function testSeasonConfig(overrides: ConfigOverrides = {}): SeasonConfig {
  return seasonConfigSchema.parse({ initialCapital: '100', riskPreset: 'custom', ...overrides, risk: { ...FIXTURE_RISK, ...overrides.risk } })
}

/** 策略单元测试用的参数：不做信号确认、RSI 80 止盈，测试行情大多构造成“最后一根 K 线刚好交叉” */
export const STRATEGY_FIXTURE: StrategyParams = { ...BASELINE_PARAMS, confirmBars: 1, rsiSellMin: 80, stopLossPct: 5, trailingStopPct: 0 }

const HOUR = 3_600_000

/** 用收盘价序列构造 1 小时 K 线，最后一根在 end 之前收盘。 */
export function makeKlines(closes: number[], end: number): Kline[] {
  const start = end - closes.length * HOUR
  return closes.map((c, i) => ({
    openTime: start + i * HOUR,
    open: String(c),
    high: String(c * 1.01),
    low: String(c * 0.99),
    close: String(c),
    volume: '1',
    closeTime: start + (i + 1) * HOUR - 1
  }))
}

/**
 * 构造“最后 lastBars 根 K 线出现交叉”的收盘价序列：
 * 前 80 根在 base，接着在 base + step，最后 lastBars 根跳到 last。
 * 再叠加 ±noise 的交替波动：20 和 50 都是偶数，交替波动在均线窗口内正好抵消，不影响交叉，
 * 但能让 RSI 落在正常区间（否则一根大阳线会把 RSI 推到接近 100）。
 */
function crossCloses(base: number, step: number, last: number, noise = 1000, lastBars = 1): number[] {
  const closes = [...Array<number>(80).fill(base), ...Array<number>(20 - lastBars).fill(base + step), ...Array<number>(lastBars).fill(last)]
  return closes.map((c, i) => c + (i % 2 ? noise : -noise))
}

/** 最新一根出现金叉（SMA20 上穿 SMA50），RSI 约 57 */
export const goldenCrossCloses = () => crossCloses(50000, -100, 52000)

/** 最新一根出现死叉 */
export const deathCrossCloses = () => crossCloses(50000, 100, 48000)

/** 金叉但 RSI 过热（没有波动，最后一根大阳线） */
export const hotGoldenCrossCloses = () => crossCloses(50000, -100, 52000, 0)

/** 短期均线连续 2 根在长期均线上方（均线基线的买入条件），RSI 正常 */
export const uptrendCloses = () => crossCloses(50000, -100, 52000, 1000, 2)

/** 短期均线连续 2 根在长期均线下方（均线基线的卖出条件） */
export const downtrendCloses = () => crossCloses(50000, 100, 48000, 1000, 2)

/** 稳定上涨：没有交叉，RSI = 100 */
export const steadyRiseCloses = () => Array.from({ length: 100 }, (_, i) => 40000 + i * 100)

/** 横盘震荡：没有交叉 */
export function flatCloses(): number[] {
  return Array.from({ length: 100 }, (_, i) => 50000 + (i % 2 ? 20 : -20))
}

export const NOW = new Date('2026-10-08T12:00:30.000Z')

export const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * 完整的模拟环境：内存数据库、模拟行情、一个赛季。
 * - 传了 llm：建一个 Provider 和一个 LLM 模型，按顺序返回这些预设的输出
 * - baseline：是否建均线基线（默认没传 llm 时建）
 */
export function setup(opts: { config?: ConfigOverrides, closes?: number[], llm?: Array<string | Error>, baseline?: boolean } = {}) {
  const store = new Store(':memory:')
  const market = new MockMarket()
  market.klines = makeKlines(opts.closes ?? flatCloses(), NOW.getTime() - 30_000)
  market.price = new Decimal(market.klines.at(-1)!.close)

  const llms = new Map<number, MockLlm>()
  let llmAgentId: number | null = null
  let providerId: number | null = null
  if (opts.llm) {
    providerId = store.insertProvider({ name: '测试服务', baseUrl: 'http://llm.local/v1', apiKey: PROVIDER_KEY }, NOW)
    llmAgentId = store.insertAgent({ kind: 'llm', name: '测试模型', color: '#2563eb', providerId, model: 'test-model', reasoningEffort: null, timeoutSeconds: 30, extraParams: null }, NOW)
    llms.set(llmAgentId, new MockLlm(opts.llm))
  }
  const baselineId = opts.baseline ?? !opts.llm ? store.insertAgent({ kind: 'baseline', name: '均线基线', color: BASELINE_COLOR }, NOW) : null
  const season = store.startSeason('测试赛季', testSeasonConfig(opts.config), NOW)

  let now = NOW
  let seq = 0
  const engine = new Engine({
    store,
    market,
    deciderFor: (agent) => {
      const llm = llms.get(agent.id)
      if (!llm) throw new Error(`模型 ${agent.name} 没有可用的 Provider`)
      return llm
    },
    logger: silentLogger,
    now: () => now,
    newId: () => `d-${++seq}`
  })
  /** 第一个参赛模型（LLM 模型优先） */
  const agentId = (llmAgentId ?? baselineId)!
  return {
    store,
    market,
    engine,
    season,
    providerId,
    llmAgentId,
    baselineId,
    agentId,
    llm: llmAgentId === null ? null : llms.get(llmAgentId)!,
    llms,
    /** 某个模型（默认第一个）在测试赛季里的运行状态 */
    state: (id = agentId) => store.entry(season.id, id),
    setNow: (d: Date) => {
      now = d
    }
  }
}

export type Env = ReturnType<typeof setup>

export const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000)

/** 切换行情：K 线在 at 之前收盘，现价 = 最后一根收盘价 */
export function setMarket(env: Env, closes: number[], at: Date) {
  env.market.klines = makeKlines(closes, at.getTime() - 1000)
  env.market.price = new Decimal(env.market.klines.at(-1)!.close)
}

/** 跑一轮，返回第一个模型（或指定模型）的结果和决策记录（没有记录时为 null） */
export async function run(env: Env, trigger: 'schedule' | 'manual' = 'schedule', agentId = env.agentId) {
  const r = await env.engine.runOnce(trigger)
  if (r.status !== 'done') throw new Error('unexpected busy')
  const o = r.outcomes.find(x => x.agentId === agentId)
  return {
    ...r,
    outcome: o?.outcome ?? null,
    decision: o?.decisionId ? env.store.getDecision(o.decisionId) : null
  }
}
