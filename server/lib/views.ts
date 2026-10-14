/**
 * 接口返回的数据组装。接口层（server/api）只负责解析参数、调用这里。
 *
 * 金额以字符串返回，保留完整精度，由前端负责格式化显示。
 * 这里返回的内容可能公开给任何人看：不包含 Provider 地址、Key 或口令。
 */
import Decimal from 'decimal.js'
import type { AgentPublic, EquityResponse, SeasonSummary, Standing, StandingsResponse, StatusResponse } from '../../shared/types/api'
import type { AgentRow, SeasonRow, Store } from './db'
import type { Engine } from './engine'
import { stopLine } from './strategy'

export interface ViewDeps {
  store: Store
  engine: Pick<Engine, 'isRunning'>
  nextRunAt: string | null
}

export const seasonSummary = (s: SeasonRow): SeasonSummary => ({ id: s.id, name: s.name, startedAt: s.startedAt, endedAt: s.endedAt, config: s.config })

export function agentPublic(a: AgentRow, providerNames: Map<number, string>): AgentPublic {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    color: a.color,
    model: a.model,
    provider: a.providerId === null ? null : providerNames.get(a.providerId) ?? null,
    reasoningEffort: a.reasoningEffort,
    status: a.status,
    createdAt: a.createdAt,
    archivedAt: a.archivedAt
  }
}

export const providerNames = (store: Store) => new Map(store.listProviders().map(p => [p.id, p.name]))

export function statusView({ store, engine, nextRunAt }: ViewDeps): StatusResponse {
  const pause = store.getPause()
  const season = store.currentSeason()
  const tick = store.latestTick()
  return {
    running: engine.isRunning,
    paused: pause.paused,
    pausedAt: pause.since,
    nextRunAt,
    lastTick: tick ? { at: tick.at, error: tick.error } : null,
    season: season ? seasonSummary(season) : null
  }
}

const pct = (value: Decimal.Value, base: Decimal.Value) => {
  const b = new Decimal(base)
  return b.gt(0) ? new Decimal(value).minus(b).div(b).mul(100).toFixed(2) : null
}

/** 赛季排行榜：每个参赛模型的资产、收益、回撤、成交和 LLM 统计，按收益率从高到低排列（还没运行过的排最后） */
export function standingsView(store: Store, season: SeasonRow, now = new Date()): StandingsResponse {
  const agents = new Map(store.listAgents().map(a => [a.id, a]))
  const names = providerNames(store)
  const latest = store.latestEquity(season.id)
  const drawdowns = store.maxDrawdowns(season.id)
  const stats = store.entryStats(season.id)
  const capital = season.config.initialCapital

  const standings: Standing[] = store.listEntries(season.id).flatMap((entry) => {
    const agent = agents.get(entry.agentId)
    if (!agent) return []
    const state = store.entry(season.id, agent.id)
    const initial = state.getInitial()
    const snap = latest.get(agent.id)
    const s = stats.get(agent.id)
    const base = snap ? new Decimal(snap.base) : null
    const position = state.getPosition()
    const holding = position && base?.gt(0)
    const entryPrice = holding ? position.cost.div(base!) : null
    const stop = holding ? stopLine(season.config.risk, entryPrice!.toNumber(), position.peak.toNumber()) : null
    const returnPct = snap ? pct(snap.total, capital) : null
    const benchmarkReturnPct = snap && initial ? pct(snap.price, initial.price) : null
    const circuit = state.getCircuit()
    return [{
      agent: agentPublic(agent, names),
      joinedAt: entry.joinedAt,
      leftAt: entry.leftAt,
      startedAt: initial?.at ?? null,
      startPrice: initial?.price ?? null,
      equity: snap?.total ?? null,
      usdt: snap?.usdt ?? null,
      base: snap?.base ?? null,
      positionValue: snap ? base!.mul(snap.price).toFixed() : null,
      entryPrice: entryPrice?.toFixed() ?? null,
      // 止损线按 number 计算，取 12 位有效数字去掉浮点尾差
      stopPrice: stop ? new Decimal(stop.price).toSignificantDigits(12).toFixed() : null,
      returnPct,
      benchmarkReturnPct,
      excessReturnPct: returnPct !== null && benchmarkReturnPct !== null ? new Decimal(returnPct).minus(benchmarkReturnPct).toFixed(2) : null,
      maxDrawdownPct: drawdowns.has(agent.id) ? drawdowns.get(agent.id)!.toFixed(2) : null,
      trades: s?.trades ?? 0,
      sells: s?.sells ?? 0,
      wins: s?.wins ?? 0,
      feesUsdt: (s?.fees ?? 0).toFixed(2),
      llm: agent.kind === 'llm'
        ? {
            asked: s?.llmAsked ?? 0,
            ok: s?.llmOk ?? 0,
            invalidOutput: s?.llmInvalid ?? 0,
            requestFailed: s?.llmFailed ?? 0,
            avgDurationMs: s?.llmAvgDurationMs ?? null,
            promptTokens: s?.llmPromptTokens ?? 0,
            completionTokens: s?.llmCompletionTokens ?? 0
          }
        : null,
      circuit: circuit && new Date(circuit.until) > now ? circuit : null
    }]
  })
  standings.sort((a, b) => (b.returnPct === null ? -Infinity : Number(b.returnPct)) - (a.returnPct === null ? -Infinity : Number(a.returnPct)))

  const first = store.firstPricedTick(season.id)
  const last = store.latestTick(season.id)
  return {
    season: seasonSummary(season),
    asOf: last?.price ? last.at : null,
    price: last?.price ?? null,
    benchmarkReturnPct: first?.price && last?.price ? pct(last.price, first.price) : null,
    standings
  }
}

/** 资产曲线：赛季里最近 days 天的行情快照和各模型的资产，点数过多时等间隔抽样；附带范围开始前的值，作为收益率的起点。 */
export function equityView(store: Store, season: SeasonRow, days: number, now = new Date(), maxPoints = 1500): EquityResponse {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const { step, points } = store.equitySeries(season.id, since, maxPoints)
  const startPrice = store.firstPricedTick(season.id)?.price ?? null
  return { seasonId: season.id, points, startPrice, base: store.equityBefore(season.id, since), intervalMs: season.config.checkIntervalMinutes * 60_000 * step }
}
