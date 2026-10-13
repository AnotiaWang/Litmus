/**
 * 数据存储：SQLite 单文件（默认 ./data/litmus.db）。
 *
 * 用 Node 内置的 node:sqlite（同步 API），不需要编译原生模块；开启 WAL，读写互不阻塞。
 * 金额、数量一律以字符串（TEXT）存储，读出后再交给 decimal.js，避免浮点误差。
 *
 * 三张表：
 * - decisions：每轮决策一条，观望、被否决、被拦截、出错的轮次都记录
 * - equity_snapshots：每轮一条资产快照，用来画资产曲线
 * - state：键值对，保存暂停状态、策略账本、持仓成本、初始预算和价格、UTC 0 点资产、面板里的设置、LLM 上次询问的时段等
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import Decimal from 'decimal.js'
import { settingsSchema, type Settings } from '../../shared/settings'
import type { Decision, Outcome } from '../../shared/types/api'

export type { Decision, Outcome }

export interface Snapshot {
  createdAt: string
  decisionId: string | null
  price: string
  usdt: string
  base: string
  total: string
  benchmark: string
}

export interface Ledger {
  usdt: Decimal
  base: Decimal
}

/** 当前持仓的成本信息，用于计算止损线。空仓时不存在。 */
export interface Position {
  /** 这笔持仓花了多少 USDT（含手续费）；部分卖出时按比例减少。持仓均价 = cost ÷ 账本持币 */
  cost: Decimal
  /** 持仓以来的最高价（移动止损用） */
  peak: Decimal
}

/** 止损 / 止盈卖出后锁定再次买入，直到短期均线回到长期均线下方 */
export interface ReentryLock {
  since: string
  reason: string
}

export interface PauseState {
  paused: boolean
  reason: string | null
  /** 'manual' 手动暂停；'daily_loss' 亏损熔断（到 until 自动恢复）；'reconcile' 账本核对失败 */
  source: 'manual' | 'daily_loss' | 'reconcile' | null
  /** 自动恢复时间（ISO），只有熔断时有 */
  until: string | null
  since: string | null
}

export interface InitialState {
  budget: string
  price: string
  at: string
}

export interface DayStart {
  /** UTC 日期 YYYY-MM-DD */
  date: string
  equity: string
}

// Decision 字段 ↔ 数据库列
const COLUMNS = {
  id: 'id',
  createdAt: 'created_at',
  trigger: 'trigger',
  symbol: 'symbol',
  mode: 'mode',
  price: 'price',
  indicators: 'indicators',
  signal: 'signal',
  signalNote: 'signal_note',
  llmDecision: 'llm_decision',
  llmSizePct: 'llm_size_pct',
  llmConfidence: 'llm_confidence',
  llmReason: 'llm_reason',
  llmRaw: 'llm_raw',
  llmCalls: 'llm_calls',
  llmPrompt: 'llm_prompt',
  riskPassed: 'risk_passed',
  riskRule: 'risk_rule',
  riskReason: 'risk_reason',
  orderSide: 'order_side',
  orderQuoteAmount: 'order_quote_amount',
  orderQty: 'order_qty',
  orderId: 'order_id',
  orderStatus: 'order_status',
  filledQty: 'filled_qty',
  filledQuote: 'filled_quote',
  commission: 'commission',
  outcome: 'outcome',
  error: 'error'
} as const satisfies Record<keyof Decision, string>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price TEXT,
  indicators TEXT,
  signal TEXT,
  signal_note TEXT,
  llm_decision TEXT,
  llm_size_pct REAL,
  llm_confidence REAL,
  llm_reason TEXT,
  llm_raw TEXT,
  llm_calls TEXT,
  llm_prompt TEXT,
  risk_passed INTEGER,
  risk_rule TEXT,
  risk_reason TEXT,
  order_side TEXT,
  order_quote_amount TEXT,
  order_qty TEXT,
  order_id TEXT,
  order_status TEXT,
  filled_qty TEXT,
  filled_quote TEXT,
  commission TEXT,
  outcome TEXT NOT NULL,
  error TEXT,
  mode TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome ON decisions(outcome, created_at);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  decision_id TEXT,
  price TEXT NOT NULL,
  usdt TEXT NOT NULL,
  base TEXT NOT NULL,
  total TEXT NOT NULL,
  benchmark TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON equity_snapshots(created_at);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 旧版本建的库没有这些后来加的列，启动时补上。ADD COLUMN 不会动已有数据，旧记录的新列为 NULL */
const ADDED_COLUMNS: Array<[column: string, type: string]> = [
  ['llm_calls', 'TEXT'],
  ['llm_prompt', 'TEXT'],
  ['mode', 'TEXT']
]

/** 以 JSON 文本存储的字段 */
const JSON_FIELDS: Array<keyof Decision> = ['indicators', 'llmCalls', 'llmPrompt']

type Row = Record<string, SQLInputValue>

function toDecision(row: Row): Decision {
  const d = {} as Record<string, unknown>
  for (const [field, col] of Object.entries(COLUMNS)) d[field] = row[col] ?? null
  for (const field of JSON_FIELDS) d[field] = d[field] ? JSON.parse(d[field] as string) : null
  d.riskPassed = d.riskPassed === null ? null : d.riskPassed === 1
  return d as unknown as Decision
}

function toRow(patch: Partial<Decision>): Row {
  const row: Row = {}
  for (const [field, value] of Object.entries(patch)) {
    const col = COLUMNS[field as keyof Decision]
    if (!col) continue
    if (JSON_FIELDS.includes(field as keyof Decision)) row[col] = value === null || value === undefined ? null : JSON.stringify(value)
    else if (field === 'riskPassed') row[col] = value === null ? null : value ? 1 : 0
    else row[col] = (value ?? null) as SQLInputValue
  }
  return row
}

type SnapshotRow = Record<'created_at' | 'decision_id' | 'price' | 'usdt' | 'base' | 'total' | 'benchmark', string | null>

function toSnapshot(r: SnapshotRow): Snapshot {
  return {
    createdAt: r.created_at!,
    decisionId: r.decision_id,
    price: r.price!,
    usdt: r.usdt!,
    base: r.base!,
    total: r.total!,
    benchmark: r.benchmark!
  }
}

/** 有交易意图的结果（用于“只看买卖信号”） */
const ACTION_SIGNALS = `signal IN ('buy', 'sell')`

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    this.addMissingColumns()
    this.migrateSettings()
  }

  /** 预算以前来自环境变量：旧库里账本已经按当时的预算初始化、但还没有保存过设置，就把那笔预算写进设置，面板上看到的才和账本一致 */
  private migrateSettings(): void {
    const initial = this.getInitial()
    if (initial && this.getState('settings') === null) this.setSettings(settingsSchema.parse({ budgetUsdt: initial.budget }))
  }

  private addMissingColumns(): void {
    const existing = new Set((this.db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(c => c.name))
    for (const [column, type] of ADDED_COLUMNS) {
      if (!existing.has(column)) this.db.exec(`ALTER TABLE decisions ADD COLUMN ${column} ${type}`)
    }
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

  // ---------- decisions ----------

  insertDecision(d: Pick<Decision, 'id' | 'createdAt' | 'trigger' | 'symbol' | 'outcome'> & Partial<Decision>): void {
    const row = toRow(d)
    const cols = Object.keys(row)
    this.db.prepare(`INSERT INTO decisions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map(c => row[c]!))
  }

  updateDecision(id: string, patch: Partial<Decision>): void {
    const row = toRow(patch)
    delete row.id
    const cols = Object.keys(row)
    if (!cols.length) return
    this.db.prepare(`UPDATE decisions SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map(c => row[c]!), id)
  }

  getDecision(id: string): Decision | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Row | undefined
    return row ? toDecision(row) : null
  }

  listDecisions(opts: { limit: number, offset: number, onlyActions: boolean }): { items: Decision[], total: number } {
    const where = opts.onlyActions ? `WHERE ${ACTION_SIGNALS}` : ''
    const rows = this.db.prepare(`SELECT * FROM decisions ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(opts.limit, opts.offset) as Row[]
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM decisions ${where}`).get() as { n: number }
    return { items: rows.map(toDecision), total: n }
  }

  /** 最近 n 条已完成的决策（不含本轮正在运行的） */
  recentDecisions(n: number): Decision[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE outcome != 'running' ORDER BY rowid DESC LIMIT ?`).all(n) as Row[]
    return rows.map(toDecision)
  }

  /** 某时刻之后的成交笔数 */
  countFilledSince(iso: string): number {
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE outcome = 'filled' AND created_at >= ?`).get(iso) as { n: number }
    return n
  }

  /** LLM 决策模式下最近 n 次真正问过 LLM 的决策（不含本轮正在运行的） */
  recentLlmDecisions(n: number): Decision[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE mode = 'llm' AND llm_decision IN ('buy', 'sell', 'hold') AND outcome != 'running' ORDER BY rowid DESC LIMIT ?`).all(n) as Row[]
    return rows.map(toDecision)
  }

  /** 最近 n 笔成交 */
  recentFills(n: number): Decision[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE outcome = 'filled' ORDER BY rowid DESC LIMIT ?`).all(n) as Row[]
    return rows.map(toDecision)
  }

  lastFilledAt(): Date | null {
    const row = this.db.prepare(`SELECT created_at FROM decisions WHERE outcome = 'filled' ORDER BY created_at DESC LIMIT 1`).get() as { created_at: string } | undefined
    return row ? new Date(row.created_at) : null
  }

  lastDecisionAt(): string | null {
    const row = this.db.prepare(`SELECT created_at FROM decisions ORDER BY rowid DESC LIMIT 1`).get() as { created_at: string } | undefined
    return row?.created_at ?? null
  }

  /** 启动时把上次进程退出时还在“运行中”的记录标记为中断，返回条数。 */
  markInterrupted(): number {
    const r = this.db.prepare(`UPDATE decisions SET outcome = 'interrupted', error = COALESCE(error, '进程在本轮运行期间退出，若已提交订单请到 Binance 核对') WHERE outcome = 'running'`).run()
    return Number(r.changes)
  }

  // ---------- equity_snapshots ----------

  insertSnapshot(s: Snapshot): void {
    this.db.prepare(`INSERT INTO equity_snapshots (created_at, decision_id, price, usdt, base, total, benchmark) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(s.createdAt, s.decisionId, s.price, s.usdt, s.base, s.total, s.benchmark)
  }

  listSnapshots(sinceIso: string): Snapshot[] {
    const rows = this.db.prepare(`SELECT * FROM equity_snapshots WHERE created_at >= ? ORDER BY id`).all(sinceIso) as SnapshotRow[]
    return rows.map(toSnapshot)
  }

  latestSnapshot(): Snapshot | null {
    const row = this.db.prepare(`SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT 1`).get() as SnapshotRow | undefined
    return row ? toSnapshot(row) : null
  }

  // ---------- state ----------

  private getState<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : null
  }

  private setState(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  /** 面板里的设置；没保存过的项用默认值 */
  getSettings(): Settings {
    return settingsSchema.parse(this.getState('settings') ?? {})
  }

  setSettings(s: Settings): void {
    this.setState('settings', s)
  }

  /**
   * 重新开始策略账本（修改预算时调用）：清掉账本、初始预算和价格、当天起始资产，下一轮按新预算重新初始化。
   * 决策记录、资产快照、暂停状态、止损后的买入锁定和已处理信号都保留。
   */
  resetLedger(): void {
    this.db.prepare(`DELETE FROM state WHERE key IN ('ledger', 'initial', 'day_start', 'position')`).run()
  }

  getLedger(): Ledger | null {
    const v = this.getState<{ usdt: string, base: string }>('ledger')
    return v ? { usdt: new Decimal(v.usdt), base: new Decimal(v.base) } : null
  }

  setLedger(l: Ledger): void {
    this.setState('ledger', { usdt: l.usdt.toFixed(), base: l.base.toFixed() })
  }

  getPosition(): Position | null {
    const v = this.getState<{ cost: string, peak: string }>('position')
    return v ? { cost: new Decimal(v.cost), peak: new Decimal(v.peak) } : null
  }

  setPosition(p: Position | null): void {
    this.setState('position', p && { cost: p.cost.toFixed(), peak: p.peak.toFixed() })
  }

  getReentryLock(): ReentryLock | null {
    return this.getState<ReentryLock>('reentry_lock')
  }

  setReentryLock(v: ReentryLock | null): void {
    this.setState('reentry_lock', v)
  }

  getPause(): PauseState {
    return this.getState<PauseState>('pause') ?? { paused: false, reason: null, source: null, until: null, since: null }
  }

  setPause(p: PauseState): void {
    this.setState('pause', p)
  }

  getInitial(): InitialState | null {
    return this.getState<InitialState>('initial')
  }

  setInitial(v: InitialState): void {
    this.setState('initial', v)
  }

  /** 最近一次处理过的信号所在 K 线（开盘时间）和方向 */
  getHandledSignal(): { candle: number, signal: 'buy' | 'sell' } | null {
    return this.getState('handled_signal')
  }

  setHandledSignal(v: { candle: number, signal: 'buy' | 'sell' }): void {
    this.setState('handled_signal', v)
  }

  /** LLM 决策模式最近一次问过 LLM 的时段（如 candle:1760000000000），同一时段只问一次 */
  getLlmSlot(): string | null {
    return this.getState<string>('llm_slot')
  }

  setLlmSlot(v: string): void {
    this.setState('llm_slot', v)
  }

  getDayStart(): DayStart | null {
    return this.getState<DayStart>('day_start')
  }

  setDayStart(v: DayStart): void {
    this.setState('day_start', v)
  }
}

/** 只读地取出数据库里保存的设置（回测用，不改动正式数据库）；数据库不存在或没保存过时返回 null。 */
export function readStoredSettings(path: string): unknown {
  if (!existsSync(path)) return null
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasState = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state'`).get()
    const row = hasState ? db.prepare(`SELECT value FROM state WHERE key = 'settings'`).get() as { value: string } | undefined : undefined
    return row ? JSON.parse(row.value) : null
  } finally {
    db.close()
  }
}
