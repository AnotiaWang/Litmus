/**
 * 管理操作：Provider、模型、赛季和站点设置。只有带口令的 /api/admin/* 接口会调用这里。
 *
 * 几条规则：
 * - Provider 下还有模型（含已归档）时不能删除；Key 只在保存时写入，读取时只给打码后的值
 * - 模型新建后自动加入当前赛季，从下一轮开始参赛；决定它“是谁”的字段不能再改（见 shared/agents.ts）
 * - 参与过运行的模型只能归档（停止参赛、保留成绩），没参与过的可以直接删除
 * - 开始新赛季会结束当前赛季，所有参赛中的模型从初始资金重新开始
 * - 正在运行一轮时不能归档、删除模型或开始新赛季
 */
import Decimal from 'decimal.js'
import { AGENT_COLORS, BASELINE_COLOR, agentInputSchema, agentUpdateSchema, providerInputSchema, providerUpdateSchema } from '../../shared/agents'
import { DEFAULT_SEASON_CONFIG, appSettingsSchema, seasonConfigSchema, type AppSettings } from '../../shared/settings'
import type { AgentAdminView, AgentTestResult, ProviderView, SeasonSummary } from '../../shared/types/api'
import type { AgentRow, Store } from './db'
import { buildDecideInput, KLINE_LIMIT, type Engine } from './engine'
import { listModels, type Decider } from './llm'
import { log as defaultLog, redact, type Logger } from './logger'
import type { Market } from './market'
import { closedKlines } from './strategy'
import { agentPublic, providerNames, seasonSummary } from './views'
import type { z } from 'zod'

export interface AdminDeps {
  store: Store
  engine: Pick<Engine, 'isRunning'>
  market: Market
  deciderFor: (agent: AgentRow) => Decider
  /** Provider 的 Key 变了以后重新登记日志打码 */
  refreshSecrets: () => void
  /** 赛季变了（运行间隔可能变了）以后重新排定下次运行 */
  reschedule: () => void
  logger?: Logger
  now?: () => Date
}

/** 带 HTTP 状态码的错误，接口层原样返回给面板 */
export class AdminError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input)
  if (!r.success) throw new AdminError(r.error.issues.map(i => `${i.path.join('.') || '(整体)'}：${i.message}`).join('；'), 400)
  return r.data
}

const nowOf = (deps: Pick<AdminDeps, 'now'>) => deps.now?.() ?? new Date()
const logOf = (deps: Pick<AdminDeps, 'logger'>) => deps.logger ?? defaultLog

function assertIdle(deps: Pick<AdminDeps, 'engine'>, what: string): void {
  if (deps.engine.isRunning) throw new AdminError(`正在运行一轮，请等这一轮结束后再${what}`, 409)
}

/** 打码：保留开头 4 位和末尾 4 位，太短时全部打码 */
export const maskKey = (key: string) => key.length <= 12 ? '***' : `${key.slice(0, 4)}…${key.slice(-4)}`

// ---------- 启动 ----------

/** 空数据库第一次启动：建一个均线基线，开始第 1 赛季（默认配置）。 */
export function bootstrap(store: Store, now = new Date()): void {
  if (store.listSeasons().length) return
  store.transaction(() => {
    if (!store.listAgents().some(a => a.kind === 'baseline')) {
      store.insertAgent({ kind: 'baseline', name: '均线基线', color: BASELINE_COLOR }, now)
    }
  })
  store.startSeason('第 1 赛季', DEFAULT_SEASON_CONFIG, now)
}

// ---------- 站点设置 ----------

export function updateAppSettings(deps: Pick<AdminDeps, 'store' | 'logger'>, input: unknown): AppSettings {
  const next = parse(appSettingsSchema, input)
  deps.store.setAppSettings(next)
  logOf(deps).info(`站点设置已更新：公开浏览${next.publicRead ? '开启' : '关闭'}`)
  return next
}

// ---------- Provider ----------

export function listProvidersView(store: Store): ProviderView[] {
  const counts = new Map<number, number>()
  for (const a of store.listAgents()) if (a.providerId !== null) counts.set(a.providerId, (counts.get(a.providerId) ?? 0) + 1)
  return store.listProviders().map(p => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKeyMasked: maskKey(p.apiKey),
    createdAt: p.createdAt,
    agentCount: counts.get(p.id) ?? 0
  }))
}

function providerOrThrow(store: Store, id: number) {
  const p = store.getProvider(id)
  if (!p) throw new AdminError('Provider 不存在', 404)
  return p
}

export function createProvider(deps: AdminDeps, input: unknown): ProviderView {
  const p = parse(providerInputSchema, input)
  const id = deps.store.insertProvider(p, nowOf(deps))
  deps.refreshSecrets()
  logOf(deps).info(`新增 Provider：${p.name}（${p.baseUrl}）`)
  return listProvidersView(deps.store).find(v => v.id === id)!
}

export function updateProvider(deps: AdminDeps, id: number, input: unknown): ProviderView {
  providerOrThrow(deps.store, id)
  const p = parse(providerUpdateSchema, input)
  deps.store.updateProvider(id, p)
  deps.refreshSecrets()
  logOf(deps).info(`修改 Provider ${id}：${p.name}（${p.baseUrl}）${p.apiKey ? '，更换了 Key' : ''}`)
  return listProvidersView(deps.store).find(v => v.id === id)!
}

export function deleteProvider(deps: AdminDeps, id: number): void {
  const p = providerOrThrow(deps.store, id)
  if (deps.store.listAgents().some(a => a.providerId === id)) throw new AdminError('这个 Provider 下还有模型（含已归档的），不能删除', 409)
  deps.store.deleteProvider(id)
  deps.refreshSecrets()
  logOf(deps).info(`删除 Provider：${p.name}`)
}

/** 列出 Provider 提供的模型，新建模型时选择用 */
export async function providerModels(deps: AdminDeps, id: number): Promise<string[]> {
  const p = providerOrThrow(deps.store, id)
  try {
    return await listModels(p.baseUrl, p.apiKey)
  } catch (e) {
    throw new AdminError(`获取模型列表失败：${redact((e as Error).message)}`, 502)
  }
}

// ---------- 模型 ----------

export function listAgentsAdmin(store: Store): AgentAdminView[] {
  const names = providerNames(store)
  return store.listAgents().map(a => ({
    ...agentPublic(a, names),
    providerId: a.providerId,
    timeoutSeconds: a.timeoutSeconds,
    extraParams: a.extraParams,
    deletable: !store.hasActivity(a.id)
  }))
}

function agentOrThrow(store: Store, id: number): AgentRow {
  const a = store.getAgent(id)
  if (!a) throw new AdminError('模型不存在', 404)
  return a
}

const agentView = (store: Store, id: number) => listAgentsAdmin(store).find(a => a.id === id)!

/** 新建模型并加入当前赛季。没指定颜色时取第一个没被参赛模型占用的颜色 */
export function createAgent(deps: AdminDeps, input: unknown): AgentAdminView {
  const a = parse(agentInputSchema, input)
  providerOrThrow(deps.store, a.providerId)
  const now = nowOf(deps)
  const used = new Set(deps.store.listAgents().filter(x => x.status === 'active').map(x => x.color.toLowerCase()))
  const color = a.color ?? AGENT_COLORS.find(c => !used.has(c)) ?? AGENT_COLORS[deps.store.listAgents().length % AGENT_COLORS.length]!
  const id = deps.store.transaction(() => {
    const id = deps.store.insertAgent({ ...a, kind: 'llm', color }, now)
    const season = deps.store.currentSeason()
    if (season) deps.store.addEntry(season.id, id, now)
    return id
  })
  logOf(deps).info(`新增模型：${a.name}（${a.model}${a.reasoningEffort ? `，思考强度 ${a.reasoningEffort}` : ''}），从下一轮开始参赛`)
  return agentView(deps.store, id)
}

export function updateAgent(deps: AdminDeps, id: number, input: unknown): AgentAdminView {
  agentOrThrow(deps.store, id)
  const a = parse(agentUpdateSchema, input)
  deps.store.updateAgent(id, a)
  return agentView(deps.store, id)
}

/** 归档：停止参赛，保留成绩。持仓不做处理，按最后一次资产快照计算成绩 */
export function archiveAgent(deps: AdminDeps, id: number): AgentAdminView {
  const agent = agentOrThrow(deps.store, id)
  if (agent.status === 'archived') return agentView(deps.store, id)
  assertIdle(deps, '归档')
  const now = nowOf(deps)
  deps.store.transaction(() => {
    deps.store.setAgentStatus(id, 'archived', now)
    const season = deps.store.currentSeason()
    if (season) deps.store.leaveEntry(season.id, id, now)
  })
  logOf(deps).info(`归档模型：${agent.name}`)
  return agentView(deps.store, id)
}

/** 删除：只能删还没参与过运行的模型 */
export function deleteAgent(deps: AdminDeps, id: number): void {
  const agent = agentOrThrow(deps.store, id)
  assertIdle(deps, '删除')
  if (deps.store.hasActivity(id)) throw new AdminError('这个模型已经参与过运行，只能归档，不能删除', 409)
  deps.store.transaction(() => deps.store.deleteAgent(id))
  logOf(deps).info(`删除模型：${agent.name}`)
}

/** 测试模型：用当前行情和一个满仓 USDT 的空账本问一次，不记录、不交易 */
export async function testAgent(deps: AdminDeps, id: number): Promise<AgentTestResult> {
  const agent = agentOrThrow(deps.store, id)
  if (agent.kind !== 'llm') throw new AdminError('均线基线不调用 LLM，不需要测试', 400)
  const config = deps.store.currentSeason()?.config ?? DEFAULT_SEASON_CONFIG
  const now = nowOf(deps)
  let input
  try {
    const rules = await deps.market.getSymbolRules(config.symbol)
    const klines = closedKlines(await deps.market.getKlines(config.symbol, config.klineInterval, KLINE_LIMIT + 1), now.getTime()).slice(-KLINE_LIMIT)
    const price = await deps.market.getPrice(config.symbol)
    const capital = new Decimal(config.initialCapital)
    input = buildDecideInput({
      config,
      rules,
      klines,
      price,
      now,
      ledger: { usdt: capital, base: new Decimal(0) },
      equity: capital,
      position: null,
      blocked: { buy: null, sell: '空仓，没有可卖的币' },
      recentDecisions: [],
      recentFills: []
    })
  } catch (e) {
    throw new AdminError(`取行情失败：${redact((e as Error).message)}`, 502)
  }
  const r = await deps.deciderFor(agent).decide(input)
  return {
    ok: r.status === 'ok',
    action: r.action,
    sizePct: r.sizePct,
    confidence: r.confidence,
    reason: r.reason,
    error: r.error ? redact(r.error) : null,
    durationMs: r.calls.reduce((a, c) => a + c.durationMs, 0),
    calls: r.calls.map(c => ({ ...c, error: c.error ? redact(c.error) : null }))
  }
}

// ---------- 赛季 ----------

/** 开始新赛季：结束当前赛季，所有参赛中的模型按新配置从初始资金重新开始 */
export function startSeason(deps: AdminDeps, input: { name?: unknown, config?: unknown }): SeasonSummary {
  assertIdle(deps, '开始新赛季')
  const config = parse(seasonConfigSchema, input.config ?? {})
  const n = deps.store.listSeasons().length + 1
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : `第 ${n} 赛季`
  const season = deps.store.startSeason(name, config, nowOf(deps))
  logOf(deps).info(`开始新赛季：${name}（${config.symbol}，${config.klineInterval}，初始资金 ${config.initialCapital} USDT）`)
  deps.reschedule()
  return seasonSummary(season)
}

export function renameSeason(deps: Pick<AdminDeps, 'store'>, id: number, name: unknown): SeasonSummary {
  if (!deps.store.getSeason(id)) throw new AdminError('赛季不存在', 404)
  if (typeof name !== 'string' || !name.trim()) throw new AdminError('赛季名称不能为空', 400)
  deps.store.renameSeason(id, name.trim().slice(0, 60))
  return seasonSummary(deps.store.getSeason(id)!)
}
