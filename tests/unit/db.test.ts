import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { archiveLegacyDatabase, Store, type Decision } from '../../server/lib/db'
import { NOW, testSeasonConfig } from './helpers'

const tempDb = () => join(mkdtempSync(join(tmpdir(), 'litmus-db-')), 'litmus.db')

describe('旧版本数据库', () => {
  it('发现旧版本（单模型）的数据库时改名备份，从空数据库重新开始；备份完整可读', () => {
    const path = tempDb()
    const old = new DatabaseSync(path)
    old.exec('PRAGMA journal_mode = WAL')
    old.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, trigger TEXT NOT NULL, symbol TEXT NOT NULL, outcome TEXT NOT NULL)`)
    old.exec(`INSERT INTO decisions VALUES ('old', '2026-10-01T00:00:00.000Z', 'schedule', 'BTCUSDT', 'filled')`)
    old.close()

    const backup = archiveLegacyDatabase(path, NOW)
    expect(backup).toBe(path.replace(/\.db$/, '.v1-20261008T120030.db'))
    expect(existsSync(path)).toBe(false)
    const restored = new DatabaseSync(backup!, { readOnly: true })
    expect(restored.prepare('SELECT id FROM decisions').all()).toEqual([{ id: 'old' }])
    restored.close()

    const store = new Store(path)
    expect(store.listSeasons()).toEqual([])
    store.close()
  })

  it('新版本的数据库和不存在的文件不处理', () => {
    const path = tempDb()
    expect(archiveLegacyDatabase(path)).toBeNull()
    new Store(path).close()
    expect(archiveLegacyDatabase(path)).toBeNull()
    expect(readdirSync(join(path, '..')).filter(f => f.includes('.v1-'))).toEqual([])
  })
})

describe('赛季与参赛记录', () => {
  it('开始新赛季时结束上一个，只有参赛中的模型加入；同一个模型在不同赛季的状态互不影响', () => {
    const store = new Store(':memory:')
    const a = store.insertAgent({ kind: 'baseline', name: 'A', color: '#000000' }, NOW)
    const b = store.insertAgent({ kind: 'baseline', name: 'B', color: '#111111' }, NOW)
    const s1 = store.startSeason('S1', testSeasonConfig(), NOW)
    store.entry(s1.id, a).setLedger({ usdt: new Decimal(1), base: new Decimal(2) })
    store.setAgentStatus(b, 'archived', NOW)
    const s2 = store.startSeason('S2', testSeasonConfig(), new Date(NOW.getTime() + 1000))
    expect(store.getSeason(s1.id)!.endedAt).not.toBeNull()
    expect(store.currentSeason()!.id).toBe(s2.id)
    expect(store.listEntries(s1.id).map(e => e.agentId)).toEqual([a, b])
    expect(store.listEntries(s2.id).map(e => e.agentId)).toEqual([a])
    expect(store.entry(s2.id, a).getLedger()).toBeNull()
    expect(store.entry(s1.id, a).getLedger()!.base.toFixed()).toBe('2')
    expect(store.listSeasons().map(s => s.name)).toEqual(['S2', 'S1'])
  })
})

describe('资产曲线与统计', () => {
  function seeded(totals: Array<[a: number, b: number | null]>) {
    const store = new Store(':memory:')
    const a = store.insertAgent({ kind: 'baseline', name: 'A', color: '#000000' }, NOW)
    const b = store.insertAgent({ kind: 'baseline', name: 'B', color: '#111111' }, NOW)
    const season = store.startSeason('S', testSeasonConfig(), NOW)
    totals.forEach(([ta, tb], i) => {
      const at = new Date(NOW.getTime() + i * 60_000).toISOString()
      const tickId = store.insertTick({ seasonId: season.id, at, trigger: 'schedule', price: String(50000 + i), error: null })
      const ledger = { usdt: new Decimal(0), base: new Decimal(0) }
      store.insertEquity(tickId, a, ledger, new Decimal(ta))
      if (tb !== null) store.insertEquity(tickId, b, ledger, new Decimal(tb))
    })
    // 一轮取行情失败：没有价格，不算进曲线
    store.insertTick({ seasonId: season.id, at: new Date(NOW.getTime() + totals.length * 60_000).toISOString(), trigger: 'schedule', price: null, error: 'x' })
    return { store, season, a, b }
  }

  it('点数过多时等间隔抽样，保留最后一个点；中途加入的模型前面没有值', () => {
    const { store, season, a, b } = seeded(Array.from({ length: 10 }, (_, i) => [100 + i, i < 5 ? null : 200 + i] as [number, number | null]))
    const { step, points } = store.equitySeries(season.id, '', 4)
    expect(step).toBe(3)
    expect(points.map(p => p.price)).toEqual(['50000', '50003', '50006', '50009'])
    expect(points[0]!.values).toEqual({ [a]: '100' })
    expect(points[2]!.values).toEqual({ [a]: '106', [b]: '206' })
    expect(store.equitySeries(season.id, new Date(NOW.getTime() + 8 * 60_000).toISOString(), 100).points).toHaveLength(2)
  })

  it('范围起点：之前最后一轮的价格和各模型之前最后一次的资产；之后才加入的模型没有值', () => {
    const { store, season, a, b } = seeded([[100, null], [110, null], [120, 200], [130, 210]])
    expect(store.equityBefore(season.id, new Date(NOW.getTime() + 2 * 60_000).toISOString())).toEqual({ price: '50001', values: { [a]: '110' } })
    expect(store.equityBefore(season.id, new Date(NOW.getTime() + 3 * 60_000).toISOString())).toEqual({ price: '50002', values: { [a]: '120', [b]: '200' } })
    expect(store.equityBefore(season.id, NOW.toISOString())).toEqual({ price: null, values: {} })
  })

  it('最大回撤：资产从此前最高点回落的最大幅度；最近一次资产快照', () => {
    const { store, season, a, b } = seeded([[100, 100], [120, 100], [90, 100], [130, 100]])
    const dd = store.maxDrawdowns(season.id)
    expect(dd.get(a)).toBeCloseTo(25)
    expect(dd.get(b)).toBe(0)
    expect(store.latestEquity(season.id).get(a)).toMatchObject({ total: '130', price: '50003' })
    expect(store.hasActivity(a)).toBe(true)
  })

  it('最近一次资产快照只看指定赛季：新赛季开始后查看旧赛季，取的是旧赛季最后一轮', () => {
    const { store, season: s1, a, b } = seeded([[100, 200], [110, null]])
    const s2 = store.startSeason('S2', testSeasonConfig(), new Date(NOW.getTime() + 3600_000))
    const tickId = store.insertTick({ seasonId: s2.id, at: new Date(NOW.getTime() + 3600_000).toISOString(), trigger: 'schedule', price: '60000', error: null })
    store.insertEquity(tickId, a, { usdt: new Decimal(0), base: new Decimal(0) }, new Decimal(999))
    const old = store.latestEquity(s1.id)
    expect(old.get(a)).toMatchObject({ total: '110', price: '50001' })
    expect(old.get(b)).toMatchObject({ total: '200', price: '50000' })
    const current = store.latestEquity(s2.id)
    expect([...current.keys()]).toEqual([a])
    expect(current.get(a)).toMatchObject({ total: '999', price: '60000' })
  })
})

describe('决策记录', () => {
  function decision(store: Store, id: string, details: boolean): Decision {
    const season = store.currentSeason() ?? store.startSeason('S', testSeasonConfig(), NOW)
    const agentId = store.listAgents()[0]?.id ?? store.insertAgent({ kind: 'baseline', name: 'A', color: '#000000' }, NOW)
    const tickId = store.insertTick({ seasonId: season.id, at: NOW.toISOString(), trigger: 'schedule', price: '50000', error: null })
    return {
      id, seasonId: season.id, agentId, tickId, createdAt: NOW.toISOString(), price: '50000', indicators: { rsi: 50 },
      signal: 'hold', signalNote: null, llmStatus: 'ok', llmDecision: 'hold', llmSizePct: 0, llmConfidence: 0.5, llmReason: '观望',
      llmRaw: details ? '{"action":"hold"}' : null,
      llmCalls: details
        ? [{ startedAt: NOW.toISOString(), durationMs: 10, model: 'm', responseModel: null, reasoningEffort: null, jsonMode: true, httpStatus: 200, finishReason: 'stop', reasoning: null, content: '{"action":"hold"}', usage: null, error: null }]
        : null,
      llmPrompt: details ? { system: '系统', user: '用户' } : null,
      llmDurationMs: 10, llmPromptTokens: 1, llmCompletionTokens: 1, riskPassed: true, riskRule: null, riskReason: null,
      orderSide: null, orderQuoteAmount: null, orderQty: null, filledQty: null, filledQuote: null, feeUsdt: null, realizedPnl: null,
      outcome: 'hold', error: null
    }
  }

  it('提示词、调用详情和原始返回单独存放：详情里有，列表和最近决策里不带', () => {
    const store = new Store(':memory:')
    const withDetails = decision(store, 'd1', true)
    const plain = decision(store, 'd2', false)
    store.transaction(() => {
      store.insertDecision(withDetails)
      store.insertDecision(plain)
    })
    expect(store.getDecision('d1')).toEqual(withDetails)
    expect(store.getDecision('d2')).toEqual(plain)
    expect(store.db.prepare('SELECT decision_id FROM decision_details').all()).toEqual([{ decision_id: 'd1' }])

    const { items, total } = store.listDecisions({ seasonId: withDetails.seasonId, onlyActions: false, limit: 10, offset: 0 })
    expect(total).toBe(2)
    const { llmRaw: _raw, llmCalls: _calls, llmPrompt: _prompt, ...summary } = withDetails
    expect(items.find(d => d.id === 'd1')).toEqual(summary)
    expect(store.recentLlmDecisions(withDetails.seasonId, withDetails.agentId, 10).every(d => !('llmPrompt' in d))).toBe(true)
  })

  it('第 2 版数据库：提示词等字段搬到 decision_details，decisions 表删掉这几列，记录完整可读', () => {
    const path = tempDb()
    const setup = new Store(path)
    const d = decision(setup, 'old', true)
    setup.close()
    // 还原成第 2 版的样子：这三列在 decisions 表里，没有 decision_details
    const v2 = new DatabaseSync(path)
    v2.exec(`ALTER TABLE decisions ADD COLUMN llm_raw TEXT; ALTER TABLE decisions ADD COLUMN llm_calls TEXT; ALTER TABLE decisions ADD COLUMN llm_prompt TEXT;
      DROP TABLE decision_details; UPDATE meta SET value = '2' WHERE key = 'schema_version'`)
    v2.prepare(`INSERT INTO decisions (id, season_id, agent_id, tick_id, created_at, price, indicators, signal, llm_status, llm_decision, llm_size_pct,
      llm_confidence, llm_reason, llm_duration_ms, llm_prompt_tokens, llm_completion_tokens, risk_passed, outcome, llm_raw, llm_calls, llm_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'hold', 'ok', 'hold', 0, 0.5, '观望', 10, 1, 1, 1, 'hold', ?, ?, ?)`).run(
      d.id, d.seasonId, d.agentId, d.tickId, d.createdAt, d.price, JSON.stringify(d.indicators), d.llmRaw, JSON.stringify(d.llmCalls), JSON.stringify(d.llmPrompt)
    )
    v2.close()

    const store = new Store(path)
    const columns = (store.db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(c => c.name)
    expect(columns).not.toContain('llm_prompt')
    expect(store.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: '3' })
    expect(store.getDecision('old')).toEqual(d)
    store.close()
    // 再次打开不会重复迁移
    const again = new Store(path)
    expect(again.getDecision('old')).toEqual(d)
    again.close()
  })
})
