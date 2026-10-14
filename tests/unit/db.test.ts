import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { archiveLegacyDatabase, Store } from '../../server/lib/db'
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
})
