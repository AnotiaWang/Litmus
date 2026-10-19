/**
 * 数据存储：SQLite 单文件（默认 ./data/litmus.db）。
 *
 * 用 Node 内置的 node:sqlite（同步 API），不需要编译原生模块；开启 WAL，读写互不阻塞。
 * 金额、数量一律以字符串（TEXT）存储，读出后再交给 decimal.js，避免浮点误差。
 *
 * 表：
 * - providers / agents：OpenAI 兼容接口和挂在上面的参赛模型（还有一个不调用 LLM 的均线基线）
 * - seasons：赛季，config 是赛季开始时定下的全部交易参数，赛季内不变
 * - entries：某个模型在某个赛季的参赛记录（加入、归档时间）；entry_state 是它的运行状态（账本、持仓等）
 * - ticks：每轮一条行情快照，所有模型共用同一份价格
 * - equity：每轮每个模型的资产，用来画曲线、算回撤
 * - decisions：决策记录，只在问过 LLM、触发止损、规则给出买卖信号或出错时写
 * - decision_details：决策的提示词、LLM 调用详情和原始返回。这些字段很长，单独存放，
 *   排行榜统计和决策列表只扫 decisions，不用读它们
 * - meta：站点设置、全局暂停等键值对
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import Decimal from 'decimal.js'
import type { AgentInput, AgentUpdate, ProviderInput } from '../../shared/agents'
import { appSettingsSchema, seasonConfigFieldsSchema, type AppSettings, type SeasonConfig } from '../../shared/settings'
import type { AgentKind, Decision, DecisionSummary, Outcome } from '../../shared/types/api'
import type { Ledger, Position } from './ledger'

export type { Decision, DecisionSummary, Outcome }

const SCHEMA_VERSION = 4

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  provider_id INTEGER REFERENCES providers(id),
  model TEXT,
  reasoning_effort TEXT,
  timeout_seconds INTEGER,
  extra_params TEXT,
  input_price_per_m REAL,
  output_price_per_m REAL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT '',
  engine_version TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  season_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (season_id, agent_id)
);

CREATE TABLE IF NOT EXISTS entry_state (
  season_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (season_id, agent_id, key)
);

CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  price TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ticks_season ON ticks(season_id, at);

CREATE TABLE IF NOT EXISTS equity (
  tick_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  usdt TEXT NOT NULL,
  base TEXT NOT NULL,
  total TEXT NOT NULL,
  PRIMARY KEY (tick_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_equity_agent ON equity(agent_id, tick_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  tick_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  price TEXT NOT NULL,
  indicators TEXT,
  signal TEXT,
  signal_note TEXT,
  llm_status TEXT,
  llm_decision TEXT,
  llm_size_pct REAL,
  llm_confidence REAL,
  llm_reason TEXT,
  llm_duration_ms INTEGER,
  llm_prompt_tokens INTEGER,
  llm_completion_tokens INTEGER,
  llm_retries INTEGER NOT NULL DEFAULT 0,
  llm_http_429 INTEGER NOT NULL DEFAULT 0,
  llm_timeouts INTEGER NOT NULL DEFAULT 0,
  risk_passed INTEGER,
  risk_rule TEXT,
  risk_reason TEXT,
  order_side TEXT,
  order_quote_amount TEXT,
  order_qty TEXT,
  filled_qty TEXT,
  filled_quote TEXT,
  fee_usdt TEXT,
  realized_pnl TEXT,
  outcome TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(season_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(season_id, created_at);

CREATE TABLE IF NOT EXISTS decision_details (
  decision_id TEXT PRIMARY KEY,
  llm_raw TEXT,
  llm_calls TEXT,
  llm_prompt TEXT
);
`

// DecisionSummary 字段 ↔ decisions 表的列
const COLUMNS = {
  id: 'id',
  seasonId: 'season_id',
  agentId: 'agent_id',
  tickId: 'tick_id',
  createdAt: 'created_at',
  price: 'price',
  indicators: 'indicators',
  signal: 'signal',
  signalNote: 'signal_note',
  llmStatus: 'llm_status',
  llmDecision: 'llm_decision',
  llmSizePct: 'llm_size_pct',
  llmConfidence: 'llm_confidence',
  llmReason: 'llm_reason',
  llmDurationMs: 'llm_duration_ms',
  llmPromptTokens: 'llm_prompt_tokens',
  llmCompletionTokens: 'llm_completion_tokens',
  llmRetries: 'llm_retries',
  llmHttp429: 'llm_http_429',
  llmTimeouts: 'llm_timeouts',
  riskPassed: 'risk_passed',
  riskRule: 'risk_rule',
  riskReason: 'risk_reason',
  orderSide: 'order_side',
  orderQuoteAmount: 'order_quote_amount',
  orderQty: 'order_qty',
  filledQty: 'filled_qty',
  filledQuote: 'filled_quote',
  feeUsdt: 'fee_usdt',
  realizedPnl: 'realized_pnl',
  outcome: 'outcome',
  error: 'error'
} as const satisfies Record<keyof DecisionSummary, string>

type Row = Record<string, SQLInputValue>

/** JSON 文本列（indicators、llm_calls、llm_prompt）解析回对象 */
const json = (v: SQLInputValue | undefined) => v ? JSON.parse(String(v)) : null

function toSummary(row: Row): DecisionSummary {
  const d = {} as Record<string, unknown>
  for (const [field, col] of Object.entries(COLUMNS)) d[field] = row[col] ?? null
  d.indicators = json(row.indicators)
  d.riskPassed = d.riskPassed === null ? null : d.riskPassed === 1
  return d as unknown as DecisionSummary
}

/** row 是 decisions 左连接 decision_details 的结果；没有详情的记录这几个字段为 null */
function toDecision(row: Row): Decision {
  return { ...toSummary(row), llmRaw: row.llm_raw == null ? null : String(row.llm_raw), llmCalls: json(row.llm_calls), llmPrompt: json(row.llm_prompt) }
}

function toRow(d: DecisionSummary): Row {
  const row: Row = {}
  for (const [field, col] of Object.entries(COLUMNS)) {
    const value = d[field as keyof DecisionSummary]
    if (field === 'indicators') row[col] = value === null || value === undefined ? null : JSON.stringify(value)
    else if (field === 'riskPassed') row[col] = value === null ? null : value ? 1 : 0
    else row[col] = (value ?? null) as SQLInputValue
  }
  return row
}

export interface ProviderRow {
  id: number
  name: string
  baseUrl: string
  apiKey: string
  createdAt: string
}

export interface AgentRow {
  id: number
  kind: AgentKind
  name: string
  color: string
  providerId: number | null
  model: string | null
  reasoningEffort: string | null
  timeoutSeconds: number | null
  extraParams: Record<string, unknown> | null
  inputPricePerM: number | null
  outputPricePerM: number | null
  status: 'active' | 'paused' | 'archived'
  createdAt: string
  archivedAt: string | null
}

export interface SeasonRow {
  id: number
  name: string
  config: SeasonConfig
  promptVersion: string
  engineVersion: string
  startedAt: string
  endedAt: string | null
}

export interface EntryRow {
  seasonId: number
  agentId: number
  joinedAt: string
  leftAt: string | null
}

export interface TickRow {
  id: number
  seasonId: number
  at: string
  trigger: 'schedule' | 'manual'
  price: string | null
  error: string | null
}

/** 账本初始化时记下的起点：用于算收益率和“一直持有”的基准 */
export interface InitialState {
  capital: string
  price: string
  at: string
}

export interface DayStart {
  /** UTC 日期 YYYY-MM-DD */
  date: string
  equity: string
}

/** 当日亏损熔断：到 until（下一个 UTC 0 点）之前不买入，卖出照常 */
export interface Circuit {
  reason: string
  until: string
}

/** 止损 / 止盈卖出后锁定再次买入，直到短期均线回到长期均线下方（均线基线用） */
export interface ReentryLock {
  since: string
  reason: string
}

/** 全局手动暂停：所有模型都不询问 LLM、不交易，资产照常记录 */
export interface PauseState {
  paused: boolean
  since: string | null
}

/** 每个模型在一个赛季里的成交和 LLM 统计 */
export interface EntryStats {
  agentId: number
  trades: number
  sells: number
  wins: number
  fees: number
  realizedPnl: number
  grossProfit: number
  grossLoss: number
  llmAsked: number
  llmOk: number
  llmInvalid: number
  llmFailed: number
  llmAvgDurationMs: number | null
  llmPromptTokens: number
  llmCompletionTokens: number
  llmRetries: number
  llmHttp429: number
  llmTimeouts: number
}

const str = (v: SQLInputValue | undefined) => v === null || v === undefined ? null : String(v)

function toAgent(r: Row): AgentRow {
  return {
    id: Number(r.id),
    kind: r.kind as AgentKind,
    name: String(r.name),
    color: String(r.color),
    providerId: r.provider_id === null ? null : Number(r.provider_id),
    model: str(r.model),
    reasoningEffort: str(r.reasoning_effort),
    timeoutSeconds: r.timeout_seconds === null ? null : Number(r.timeout_seconds),
    extraParams: r.extra_params ? JSON.parse(String(r.extra_params)) : null,
    inputPricePerM: r.input_price_per_m === null || r.input_price_per_m === undefined ? null : Number(r.input_price_per_m),
    outputPricePerM: r.output_price_per_m === null || r.output_price_per_m === undefined ? null : Number(r.output_price_per_m),
    status: r.status as AgentRow['status'],
    createdAt: String(r.created_at),
    archivedAt: str(r.archived_at)
  }
}

function toSeason(r: Row): SeasonRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    config: seasonConfigFieldsSchema.parse(JSON.parse(String(r.config))),
    promptVersion: str(r.prompt_version) ?? '',
    engineVersion: str(r.engine_version) ?? '',
    startedAt: String(r.started_at),
    endedAt: str(r.ended_at)
  }
}

const toEntry = (r: Row): EntryRow => ({ seasonId: Number(r.season_id), agentId: Number(r.agent_id), joinedAt: String(r.joined_at), leftAt: str(r.left_at) })

const toTick = (r: Row): TickRow => ({ id: Number(r.id), seasonId: Number(r.season_id), at: String(r.at), trigger: r.trigger as TickRow['trigger'], price: str(r.price), error: str(r.error) })

/**
 * 上一个版本（单模型、Demo 下单）的数据库和现在的结构不兼容：发现时改名备份，返回备份路径；不是旧库时返回 null。
 * 打开再关闭一次，让 WAL 里的内容合并回主文件，改名后备份是完整的。
 */
export function archiveLegacyDatabase(path: string, now = new Date()): string | null {
  if (!existsSync(path)) return null
  const db = new DatabaseSync(path)
  let legacy: boolean
  try {
    const columns = (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(c => c.name)
    legacy = columns.length > 0 && !columns.includes('season_id')
  } finally {
    db.close()
  }
  if (!legacy) return null
  const backup = path.replace(/\.db$/, '') + `.v1-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}.db`
  renameSync(path, backup)
  return backup
}

/** 某个模型在某个赛季里的运行状态（账本、持仓、熔断等），存在 entry_state 表里 */
export class EntryState {
  constructor(private readonly db: DatabaseSync, readonly seasonId: number, readonly agentId: number) {}

  private get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM entry_state WHERE season_id = ? AND agent_id = ? AND key = ?').get(this.seasonId, this.agentId, key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : null
  }

  private set(key: string, value: unknown): void {
    if (value === null) {
      this.db.prepare('DELETE FROM entry_state WHERE season_id = ? AND agent_id = ? AND key = ?').run(this.seasonId, this.agentId, key)
      return
    }
    this.db.prepare('INSERT INTO entry_state (season_id, agent_id, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(season_id, agent_id, key) DO UPDATE SET value = excluded.value')
      .run(this.seasonId, this.agentId, key, JSON.stringify(value))
  }

  getLedger(): Ledger | null {
    const v = this.get<{ usdt: string, base: string }>('ledger')
    return v ? { usdt: new Decimal(v.usdt), base: new Decimal(v.base) } : null
  }

  setLedger(l: Ledger): void {
    this.set('ledger', { usdt: l.usdt.toFixed(), base: l.base.toFixed() })
  }

  getPosition(): Position | null {
    const v = this.get<{ cost: string, peak: string, openedAt?: string }>('position')
    return v ? { cost: new Decimal(v.cost), peak: new Decimal(v.peak), ...(v.openedAt ? { openedAt: v.openedAt } : {}) } : null
  }

  setPosition(p: Position | null): void {
    this.set('position', p && { cost: p.cost.toFixed(), peak: p.peak.toFixed(), ...(p.openedAt ? { openedAt: p.openedAt } : {}) })
  }

  getInitial(): InitialState | null {
    return this.get<InitialState>('initial')
  }

  setInitial(v: InitialState): void {
    this.set('initial', v)
  }

  getDayStart(): DayStart | null {
    return this.get<DayStart>('day_start')
  }

  setDayStart(v: DayStart): void {
    this.set('day_start', v)
  }

  getCircuit(): Circuit | null {
    return this.get<Circuit>('circuit')
  }

  setCircuit(v: Circuit | null): void {
    this.set('circuit', v)
  }

  getReentryLock(): ReentryLock | null {
    return this.get<ReentryLock>('reentry_lock')
  }

  setReentryLock(v: ReentryLock | null): void {
    this.set('reentry_lock', v)
  }

  /** 最近一次处理过的规则信号所在 K 线（开盘时间）和方向（均线基线用） */
  getHandledSignal(): { candle: number, signal: 'buy' | 'sell' } | null {
    return this.get('handled_signal')
  }

  setHandledSignal(v: { candle: number, signal: 'buy' | 'sell' }): void {
    this.set('handled_signal', v)
  }

  /** 最近一次问过 LLM 的时段（如 candle:1h:1760000000000），同一时段只问一次 */
  getLlmSlot(): string | null {
    return this.get<string>('llm_slot')
  }

  setLlmSlot(v: string): void {
    this.set('llm_slot', v)
  }
}

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    let version = this.getMeta<number>('schema_version')
    if (version === 2) {
      this.migrateDecisionDetails()
      this.setMeta('schema_version', 3)
      version = 3
    }
    if (version === 3) {
      this.migrateV4()
      this.setMeta('schema_version', 4)
      version = 4
    }
    if (version === null) this.setMeta('schema_version', SCHEMA_VERSION)
  }

  /**
   * 第 2 版把提示词、调用详情和原始返回存在 decisions 表里：搬到 decision_details，再从 decisions 删掉这几列。
   * 删列后原来的页大半是空的（新记录只追加在后面，不会填回去），VACUUM 一次把表压紧
   */
  private migrateDecisionDetails(): void {
    this.transaction(() => {
      this.db.exec(`INSERT INTO decision_details (decision_id, llm_raw, llm_calls, llm_prompt)
        SELECT id, llm_raw, llm_calls, llm_prompt FROM decisions
        WHERE llm_raw IS NOT NULL OR llm_calls IS NOT NULL OR llm_prompt IS NOT NULL`)
      for (const col of ['llm_raw', 'llm_calls', 'llm_prompt']) this.db.exec(`ALTER TABLE decisions DROP COLUMN ${col}`)
    })
    this.db.exec('VACUUM')
  }

  /**
   * 第 4 版：模型成本单价、赛季的提示词/引擎版本、LLM 重试/429/超时统计。
   * 旧赛季没有版本记录，统一标成 legacy，页面会提示“中途升级过”。
   */
  private migrateV4(): void {
    this.transaction(() => {
      const columns = (table: string) => new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
      const add = (table: string, column: string, definition: string) => {
        if (!columns(table).has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      }
      add('agents', 'input_price_per_m', 'REAL')
      add('agents', 'output_price_per_m', 'REAL')
      add('seasons', 'prompt_version', `TEXT NOT NULL DEFAULT ''`)
      add('seasons', 'engine_version', `TEXT NOT NULL DEFAULT ''`)
      add('decisions', 'llm_retries', 'INTEGER NOT NULL DEFAULT 0')
      add('decisions', 'llm_http_429', 'INTEGER NOT NULL DEFAULT 0')
      add('decisions', 'llm_timeouts', 'INTEGER NOT NULL DEFAULT 0')
      this.db.exec(`UPDATE seasons SET prompt_version = 'legacy' WHERE prompt_version = ''`)
      this.db.exec(`UPDATE seasons SET engine_version = 'legacy' WHERE engine_version = ''`)
    })
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  /** 在一个事务里执行，出错自动回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- meta ----------

  private getMeta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : null
  }

  private setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  getAppSettings(): AppSettings {
    return appSettingsSchema.parse(this.getMeta('app_settings') ?? {})
  }

  setAppSettings(s: AppSettings): void {
    this.setMeta('app_settings', s)
  }

  getPause(): PauseState {
    return this.getMeta<PauseState>('pause') ?? { paused: false, since: null }
  }

  setPause(p: PauseState): void {
    this.setMeta('pause', p)
  }

  // ---------- providers ----------

  listProviders(): ProviderRow[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY id').all() as Row[]
    return rows.map(r => ({ id: Number(r.id), name: String(r.name), baseUrl: String(r.base_url), apiKey: String(r.api_key), createdAt: String(r.created_at) }))
  }

  getProvider(id: number): ProviderRow | null {
    return this.listProviders().find(p => p.id === id) ?? null
  }

  insertProvider(p: ProviderInput, now: Date): number {
    const r = this.db.prepare('INSERT INTO providers (name, base_url, api_key, created_at) VALUES (?, ?, ?, ?)').run(p.name, p.baseUrl, p.apiKey, now.toISOString())
    return Number(r.lastInsertRowid)
  }

  /** apiKey 为 undefined 时不改 */
  updateProvider(id: number, p: { name: string, baseUrl: string, apiKey?: string }): void {
    this.db.prepare('UPDATE providers SET name = ?, base_url = ?, api_key = COALESCE(?, api_key) WHERE id = ?').run(p.name, p.baseUrl, p.apiKey ?? null, id)
  }

  deleteProvider(id: number): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
  }

  // ---------- agents ----------

  listAgents(): AgentRow[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY id').all() as Row[]).map(toAgent)
  }

  getAgent(id: number): AgentRow | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined
    return row ? toAgent(row) : null
  }

  insertAgent(a: { kind: AgentKind, name: string, color: string } & Partial<Omit<AgentInput, 'name' | 'color'>>, now: Date): number {
    const r = this.db.prepare(`INSERT INTO agents (kind, name, color, provider_id, model, reasoning_effort, timeout_seconds, extra_params, input_price_per_m, output_price_per_m, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      a.kind, a.name, a.color, a.providerId ?? null, a.model ?? null, a.reasoningEffort ?? null,
      a.timeoutSeconds ?? null, a.extraParams ? JSON.stringify(a.extraParams) : null,
      a.inputPricePerM ?? null, a.outputPricePerM ?? null, now.toISOString()
    )
    return Number(r.lastInsertRowid)
  }

  updateAgent(id: number, a: AgentUpdate): void {
    this.db.prepare(`UPDATE agents SET name = ?, color = ?, timeout_seconds = CASE WHEN kind = 'llm' THEN ? ELSE timeout_seconds END,
      input_price_per_m = ?, output_price_per_m = ? WHERE id = ?`)
      .run(a.name, a.color, a.timeoutSeconds, a.inputPricePerM, a.outputPricePerM, id)
  }

  setAgentStatus(id: number, status: AgentRow['status'], now: Date): void {
    this.db.prepare('UPDATE agents SET status = ?, archived_at = ? WHERE id = ?').run(status, status === 'archived' ? now.toISOString() : null, id)
  }

  /** 只删没有任何资产快照和决策记录的模型（调用方先用 hasActivity 检查） */
  deleteAgent(id: number): void {
    this.db.prepare('DELETE FROM entry_state WHERE agent_id = ?').run(id)
    this.db.prepare('DELETE FROM entries WHERE agent_id = ?').run(id)
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  /** 是否已经参与过运行（有资产快照或决策记录） */
  hasActivity(agentId: number): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM equity WHERE agent_id = ? UNION ALL SELECT 1 FROM decisions WHERE agent_id = ? LIMIT 1').get(agentId, agentId))
  }

  // ---------- seasons & entries ----------

  currentSeason(): SeasonRow | null {
    const row = this.db.prepare('SELECT * FROM seasons WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as Row | undefined
    return row ? toSeason(row) : null
  }

  getSeason(id: number): SeasonRow | null {
    const row = this.db.prepare('SELECT * FROM seasons WHERE id = ?').get(id) as Row | undefined
    return row ? toSeason(row) : null
  }

  listSeasons(): SeasonRow[] {
    return (this.db.prepare('SELECT * FROM seasons ORDER BY id DESC').all() as Row[]).map(toSeason)
  }

  /**
   * 结束当前赛季（如果有），开始新赛季，所有未归档的模型自动加入。
   * paused 的模型也加入，恢复后可以继续参赛；是否实际运行由引擎按 status 过滤。
   */
  startSeason(name: string, config: SeasonConfig, now: Date, versions: { promptVersion?: string, engineVersion?: string } = {}): SeasonRow {
    return this.transaction(() => {
      const at = now.toISOString()
      this.db.prepare('UPDATE seasons SET ended_at = ? WHERE ended_at IS NULL').run(at)
      const r = this.db.prepare('INSERT INTO seasons (name, config, prompt_version, engine_version, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, JSON.stringify(config), versions.promptVersion ?? '', versions.engineVersion ?? '', at)
      const id = Number(r.lastInsertRowid)
      for (const agent of this.listAgents().filter(a => a.status !== 'archived')) this.addEntry(id, agent.id, now)
      return this.getSeason(id)!
    })
  }

  renameSeason(id: number, name: string): void {
    this.db.prepare('UPDATE seasons SET name = ? WHERE id = ?').run(name, id)
  }

  listEntries(seasonId: number): EntryRow[] {
    return (this.db.prepare('SELECT * FROM entries WHERE season_id = ? ORDER BY agent_id').all(seasonId) as Row[]).map(toEntry)
  }

  addEntry(seasonId: number, agentId: number, now: Date): void {
    this.db.prepare('INSERT OR IGNORE INTO entries (season_id, agent_id, joined_at) VALUES (?, ?, ?)').run(seasonId, agentId, now.toISOString())
  }

  leaveEntry(seasonId: number, agentId: number, now: Date): void {
    this.db.prepare('UPDATE entries SET left_at = ? WHERE season_id = ? AND agent_id = ? AND left_at IS NULL').run(now.toISOString(), seasonId, agentId)
  }

  entry(seasonId: number, agentId: number): EntryState {
    return new EntryState(this.db, seasonId, agentId)
  }

  // ---------- ticks & equity ----------

  insertTick(t: Omit<TickRow, 'id'>): number {
    const r = this.db.prepare('INSERT INTO ticks (season_id, at, trigger, price, error) VALUES (?, ?, ?, ?, ?)').run(t.seasonId, t.at, t.trigger, t.price, t.error)
    return Number(r.lastInsertRowid)
  }

  latestTick(seasonId?: number): TickRow | null {
    const row = (seasonId === undefined
      ? this.db.prepare('SELECT * FROM ticks ORDER BY id DESC LIMIT 1').get()
      : this.db.prepare('SELECT * FROM ticks WHERE season_id = ? ORDER BY id DESC LIMIT 1').get(seasonId)) as Row | undefined
    return row ? toTick(row) : null
  }

  /** 赛季里第一条有价格的行情快照（赛季“一直持有”基准的起点） */
  firstPricedTick(seasonId: number): TickRow | null {
    const row = this.db.prepare('SELECT * FROM ticks WHERE season_id = ? AND price IS NOT NULL ORDER BY id LIMIT 1').get(seasonId) as Row | undefined
    return row ? toTick(row) : null
  }

  insertEquity(tickId: number, agentId: number, ledger: Ledger, total: Decimal): void {
    this.db.prepare('INSERT INTO equity (tick_id, agent_id, usdt, base, total) VALUES (?, ?, ?, ?, ?)')
      .run(tickId, agentId, ledger.usdt.toFixed(), ledger.base.toFixed(), total.toFixed())
  }

  /**
   * 每个模型在赛季里最近一次的资产快照。
   * 先在这个赛季的行情快照里按模型求最后一轮，再连回资产表：只扫这个赛季的数据，查看旧赛季也不会变慢
   */
  latestEquity(seasonId: number): Map<number, { at: string, price: string, usdt: string, base: string, total: string }> {
    const rows = this.db.prepare(`
      SELECT e.agent_id, e.usdt, e.base, e.total, t.at, t.price FROM (
        SELECT e.agent_id, MAX(e.tick_id) AS tick_id FROM equity e JOIN ticks t ON t.id = e.tick_id
        WHERE t.season_id = ? GROUP BY e.agent_id
      ) last
      JOIN equity e ON e.tick_id = last.tick_id AND e.agent_id = last.agent_id
      JOIN ticks t ON t.id = e.tick_id
    `).all(seasonId) as Row[]
    return new Map(rows.map(r => [Number(r.agent_id), { at: String(r.at), price: String(r.price), usdt: String(r.usdt), base: String(r.base), total: String(r.total) }]))
  }

  /** 每个模型在赛季里的最大回撤（%）：资产从此前最高点回落的最大幅度 */
  maxDrawdowns(seasonId: number): Map<number, number> {
    const rows = this.db.prepare(`
      SELECT agent_id, MAX((peak - total) / peak) * 100 AS dd FROM (
        SELECT e.agent_id, CAST(e.total AS REAL) AS total,
          MAX(CAST(e.total AS REAL)) OVER (PARTITION BY e.agent_id ORDER BY e.tick_id ROWS UNBOUNDED PRECEDING) AS peak
        FROM equity e JOIN ticks t ON t.id = e.tick_id WHERE t.season_id = ?
      ) WHERE peak > 0 GROUP BY agent_id
    `).all(seasonId) as Array<{ agent_id: number, dd: number }>
    return new Map(rows.map(r => [Number(r.agent_id), r.dd]))
  }

  /**
   * 资产曲线：赛季里 since 之后的行情快照，点数超过 maxPoints 时等间隔抽样（保留最后一个点），
   * 带上每个快照里各模型的资产总值。返回抽样步长，前端据此判断断档。
   */
  equitySeries(seasonId: number, sinceIso: string, maxPoints: number): { step: number, points: Array<{ t: string, price: string, values: Record<string, string>, bases: Record<string, string> }> } {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM ticks WHERE season_id = ? AND at >= ? AND price IS NOT NULL').get(seasonId, sinceIso) as { n: number }
    const step = Math.max(1, Math.ceil(n / maxPoints))
    const rows = this.db.prepare(`
      WITH numbered AS (
        SELECT id, at, price, ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn FROM ticks
        WHERE season_id = ? AND at >= ? AND price IS NOT NULL
      ), picked AS (SELECT id, at, price FROM numbered WHERE rn % ? = 0 OR rn = ? - 1)
      SELECT p.id, p.at, p.price, e.agent_id, e.base, e.total FROM picked p LEFT JOIN equity e ON e.tick_id = p.id ORDER BY p.id
    `).all(seasonId, sinceIso, step, n) as Array<{ id: number, at: string, price: string, agent_id: number | null, base: string | null, total: string | null }>
    const points: Array<{ t: string, price: string, values: Record<string, string>, bases: Record<string, string> }> = []
    let lastId: number | null = null
    for (const r of rows) {
      if (r.id !== lastId) {
        points.push({ t: r.at, price: r.price, values: {}, bases: {} })
        lastId = r.id
      }
      if (r.agent_id !== null && r.total !== null) {
        points.at(-1)!.values[r.agent_id] = r.total
        if (r.base !== null) points.at(-1)!.bases[r.agent_id] = r.base
      }
    }
    return { step, points }
  }

  /**
   * 时间点之前最后一轮的价格，和各模型在那之前的最后一次资产，作为曲线在这个时间范围内的起点。
   * 那之前还没运行过（或模型是之后才加入的）就没有对应的值
   */
  equityBefore(seasonId: number, beforeIso: string): { price: string | null, values: Record<string, string> } {
    const tick = this.db.prepare('SELECT price FROM ticks WHERE season_id = ? AND at < ? AND price IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get(seasonId, beforeIso) as { price: string } | undefined
    // SQLite 里和 MAX() 一起查询的列取自 MAX 所在的那一行，即每个模型最后一次的资产
    const rows = this.db.prepare(`
      SELECT e.agent_id, e.total, MAX(e.tick_id) FROM equity e JOIN ticks t ON t.id = e.tick_id
      WHERE t.season_id = ? AND t.at < ? GROUP BY e.agent_id
    `).all(seasonId, beforeIso) as Array<{ agent_id: number, total: string }>
    return { price: tick?.price ?? null, values: Object.fromEntries(rows.map(r => [r.agent_id, r.total])) }
  }

  // ---------- decisions ----------

  /** 写 decisions 和 decision_details 两张表，调用方（引擎）在同一个事务里调用 */
  insertDecision(d: Decision): void {
    const row = toRow(d)
    const cols = Object.keys(row)
    this.db.prepare(`INSERT INTO decisions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map(c => row[c]!))
    if (d.llmRaw === null && d.llmCalls === null && d.llmPrompt === null) return
    this.db.prepare('INSERT INTO decision_details (decision_id, llm_raw, llm_calls, llm_prompt) VALUES (?, ?, ?, ?)').run(
      d.id, d.llmRaw, d.llmCalls && JSON.stringify(d.llmCalls), d.llmPrompt && JSON.stringify(d.llmPrompt)
    )
  }

  getDecision(id: string): Decision | null {
    const row = this.db.prepare(`SELECT d.*, x.llm_raw, x.llm_calls, x.llm_prompt FROM decisions d
      LEFT JOIN decision_details x ON x.decision_id = d.id WHERE d.id = ?`).get(id) as Row | undefined
    return row ? toDecision(row) : null
  }

  /** onlyActions：只看有交易意图的（买入 / 卖出信号）。列表不带提示词和调用详情，要看用 getDecision */
  listDecisions(opts: { seasonId: number, agentId?: number, onlyActions: boolean, limit: number, offset: number }): { items: DecisionSummary[], total: number } {
    const where = ['season_id = ?']
    const params: SQLInputValue[] = [opts.seasonId]
    if (opts.agentId !== undefined) {
      where.push('agent_id = ?')
      params.push(opts.agentId)
    }
    if (opts.onlyActions) where.push(`signal IN ('buy', 'sell')`)
    const sql = `FROM decisions WHERE ${where.join(' AND ')}`
    const rows = this.db.prepare(`SELECT * ${sql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, opts.limit, opts.offset) as Row[]
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params) as { n: number }
    return { items: rows.map(toSummary), total: n }
  }

  /** 某个模型最近 n 次 LLM 给出的合法决策 */
  recentLlmDecisions(seasonId: number, agentId: number, n: number): DecisionSummary[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE season_id = ? AND agent_id = ? AND llm_status = 'ok' ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(seasonId, agentId, n) as Row[]
    return rows.map(toSummary)
  }

  /** 某个模型最近 n 笔成交 */
  recentFills(seasonId: number, agentId: number, n: number): DecisionSummary[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE season_id = ? AND agent_id = ? AND outcome = 'filled' ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(seasonId, agentId, n) as Row[]
    return rows.map(toSummary)
  }

  /** 某时刻之后的成交笔数 */
  countFillsSince(seasonId: number, agentId: number, iso: string): number {
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE season_id = ? AND agent_id = ? AND outcome = 'filled' AND created_at >= ?`).get(seasonId, agentId, iso) as { n: number }
    return n
  }

  lastFillAt(seasonId: number, agentId: number): Date | null {
    const row = this.db.prepare(`SELECT created_at FROM decisions WHERE season_id = ? AND agent_id = ? AND outcome = 'filled' ORDER BY created_at DESC LIMIT 1`).get(seasonId, agentId) as { created_at: string } | undefined
    return row ? new Date(row.created_at) : null
  }

  /** 各模型在赛季里的成交和 LLM 询问统计 */
  entryStats(seasonId: number): Map<number, EntryStats> {
    const rows = this.db.prepare(`
      SELECT agent_id,
        SUM(outcome = 'filled') AS trades,
        SUM(outcome = 'filled' AND order_side = 'sell') AS sells,
        SUM(outcome = 'filled' AND order_side = 'sell' AND CAST(realized_pnl AS REAL) > 0) AS wins,
        TOTAL(CASE WHEN outcome = 'filled' THEN CAST(fee_usdt AS REAL) END) AS fees,
        TOTAL(CASE WHEN outcome = 'filled' THEN CAST(realized_pnl AS REAL) END) AS realized_pnl,
        TOTAL(CASE WHEN outcome = 'filled' AND order_side = 'sell' AND CAST(realized_pnl AS REAL) > 0 THEN CAST(realized_pnl AS REAL) END) AS gross_profit,
        TOTAL(CASE WHEN outcome = 'filled' AND order_side = 'sell' AND CAST(realized_pnl AS REAL) <= 0 THEN CAST(realized_pnl AS REAL) END) AS gross_loss,
        SUM(llm_status IS NOT NULL) AS asked,
        SUM(llm_status = 'ok') AS ok,
        SUM(llm_status = 'invalid_output') AS invalid,
        SUM(llm_status = 'request_failed') AS failed,
        AVG(CASE WHEN llm_status != 'request_failed' THEN llm_duration_ms END) AS avg_ms,
        TOTAL(llm_prompt_tokens) AS prompt_tokens,
        TOTAL(llm_completion_tokens) AS completion_tokens,
        TOTAL(llm_retries) AS retries,
        TOTAL(llm_http_429) AS http_429,
        TOTAL(llm_timeouts) AS timeouts
      FROM decisions WHERE season_id = ? GROUP BY agent_id
    `).all(seasonId) as Array<Record<string, number | null>>
    return new Map(rows.map(r => [Number(r.agent_id), {
      agentId: Number(r.agent_id),
      trades: Number(r.trades ?? 0),
      sells: Number(r.sells ?? 0),
      wins: Number(r.wins ?? 0),
      fees: Number(r.fees ?? 0),
      realizedPnl: Number(r.realized_pnl ?? 0),
      grossProfit: Number(r.gross_profit ?? 0),
      grossLoss: Number(r.gross_loss ?? 0),
      llmAsked: Number(r.asked ?? 0),
      llmOk: Number(r.ok ?? 0),
      llmInvalid: Number(r.invalid ?? 0),
      llmFailed: Number(r.failed ?? 0),
      llmAvgDurationMs: r.avg_ms === null ? null : Math.round(Number(r.avg_ms)),
      llmPromptTokens: Number(r.prompt_tokens ?? 0),
      llmCompletionTokens: Number(r.completion_tokens ?? 0),
      llmRetries: Number(r.retries ?? 0),
      llmHttp429: Number(r.http_429 ?? 0),
      llmTimeouts: Number(r.timeouts ?? 0)
    }]))
  }

  /** 每个模型 LLM 耗时的 p50 / p95 / 最大值（只统计有耗时的询问，含重试的总耗时） */
  llmLatency(seasonId: number): Map<number, { p50: number, p95: number, max: number }> {
    const rows = this.db.prepare(`SELECT agent_id, llm_duration_ms FROM decisions
      WHERE season_id = ? AND llm_duration_ms IS NOT NULL ORDER BY agent_id, llm_duration_ms`).all(seasonId) as Array<{ agent_id: number, llm_duration_ms: number }>
    const byAgent = new Map<number, number[]>()
    for (const r of rows) {
      const list = byAgent.get(Number(r.agent_id)) ?? []
      list.push(Number(r.llm_duration_ms))
      byAgent.set(Number(r.agent_id), list)
    }
    const pick = (list: number[], p: number) => list[Math.min(list.length - 1, Math.floor(list.length * p))]!
    return new Map([...byAgent].map(([id, list]) => [id, { p50: pick(list, 0.5), p95: pick(list, 0.95), max: list.at(-1)! }]))
  }

  /** 每个模型在赛季里的平均持币市值占比，按每轮资产快照计算 */
  exposureStats(seasonId: number): Map<number, number> {
    const rows = this.db.prepare(`
      SELECT e.agent_id,
        AVG(CASE WHEN CAST(e.total AS REAL) > 0 THEN CAST(e.base AS REAL) * CAST(t.price AS REAL) / CAST(e.total AS REAL) * 100 END) AS avg
      FROM equity e JOIN ticks t ON t.id = e.tick_id
      WHERE t.season_id = ? GROUP BY e.agent_id
    `).all(seasonId) as Array<{ agent_id: number, avg: number | null }>
    return new Map(rows.filter(r => r.avg !== null).map(r => [Number(r.agent_id), Number(r.avg)]))
  }

  /** 每轮收益率的均值和波动：用于判断排名差异是否只是噪声 */
  returnStats(seasonId: number): Map<number, { tStat: number | null, periodVolPct: number | null }> {
    const rows = this.db.prepare(`
      WITH r AS (
        SELECT e.agent_id, CAST(e.total AS REAL) AS total,
          LAG(CAST(e.total AS REAL)) OVER (PARTITION BY e.agent_id ORDER BY e.tick_id) AS prev
        FROM equity e JOIN ticks t ON t.id = e.tick_id WHERE t.season_id = ?
      )
      SELECT agent_id, COUNT(*) AS n, AVG(total / prev - 1) AS mean,
        AVG((total / prev - 1) * (total / prev - 1)) AS mean_sq
      FROM r WHERE prev IS NOT NULL AND prev > 0 GROUP BY agent_id
    `).all(seasonId) as Array<{ agent_id: number, n: number, mean: number | null, mean_sq: number | null }>
    return new Map(rows.map((r) => {
      const n = Number(r.n)
      const mean = Number(r.mean ?? 0)
      const variance = Math.max(0, Number(r.mean_sq ?? 0) - mean * mean)
      const sd = Math.sqrt(variance)
      return [Number(r.agent_id), {
        tStat: n > 1 && sd > 0 ? mean / sd * Math.sqrt(n) : null,
        periodVolPct: n > 1 ? sd * Math.sqrt(n) * 100 : null
      }]
    }))
  }

  /** 赛季的轮数、决策数和成交数，用来说明样本量 */
  seasonSample(seasonId: number): { rounds: number, decisions: number, trades: number } {
    const rounds = Number((this.db.prepare('SELECT COUNT(*) AS n FROM ticks WHERE season_id = ? AND price IS NOT NULL').get(seasonId) as { n: number }).n)
    const decisions = Number((this.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE season_id = ?').get(seasonId) as { n: number }).n)
    const trades = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE season_id = ? AND outcome = 'filled'`).get(seasonId) as { n: number }).n)
    return { rounds, decisions, trades }
  }

  /** 每个模型最近一次被询问的时间 */
  lastLlmAsked(seasonId: number): Map<number, string> {
    const rows = this.db.prepare(`SELECT agent_id, MAX(created_at) AS at FROM decisions
      WHERE season_id = ? AND llm_status IS NOT NULL GROUP BY agent_id`).all(seasonId) as Array<{ agent_id: number, at: string }>
    return new Map(rows.map(r => [Number(r.agent_id), String(r.at)]))
  }

  /** 每个模型最近一次 LLM 错误（最终失败或重试后成功都会记录 error 的只有前者） */
  lastLlmErrors(seasonId: number): Map<number, { at: string, error: string }> {
    const rows = this.db.prepare(`SELECT agent_id, created_at, error FROM decisions
      WHERE season_id = ? AND error IS NOT NULL ORDER BY created_at DESC`).all(seasonId) as Array<{ agent_id: number, created_at: string, error: string }>
    const map = new Map<number, { at: string, error: string }>()
    for (const r of rows) if (!map.has(Number(r.agent_id))) map.set(Number(r.agent_id), { at: String(r.created_at), error: String(r.error) })
    return map
  }

  /** 赛季里的全部成交，按时间正序，用来在曲线上画买卖点 */
  listFills(seasonId: number): Array<{ t: string, agentId: number, side: 'buy' | 'sell', price: string, qty: string, quote: string, realizedPnl: string | null }> {
    const rows = this.db.prepare(`SELECT created_at, agent_id, order_side, price, filled_qty, filled_quote, realized_pnl
      FROM decisions WHERE season_id = ? AND outcome = 'filled' ORDER BY created_at, rowid`).all(seasonId) as Row[]
    return rows.map(r => ({
      t: String(r.created_at),
      agentId: Number(r.agent_id),
      side: r.order_side === 'buy' ? 'buy' : 'sell',
      price: String(r.price),
      qty: String(r.filled_qty),
      quote: String(r.filled_quote),
      realizedPnl: str(r.realized_pnl)
    }))
  }
}
