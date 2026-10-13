import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Store } from '../../server/lib/db'

describe('数据库升级', () => {
  it('旧库缺少 LLM 调用详情两列时自动补上，旧记录照常读取', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'litmus-db-')), 'litmus.db')
    // 升级前的表结构（没有 llm_calls、llm_prompt）
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, trigger TEXT NOT NULL, symbol TEXT NOT NULL,
      price TEXT, indicators TEXT, signal TEXT, signal_note TEXT,
      llm_decision TEXT, llm_size_pct REAL, llm_confidence REAL, llm_reason TEXT, llm_raw TEXT,
      risk_passed INTEGER, risk_rule TEXT, risk_reason TEXT,
      order_side TEXT, order_quote_amount TEXT, order_qty TEXT, order_id TEXT, order_status TEXT,
      filled_qty TEXT, filled_quote TEXT, commission TEXT, outcome TEXT NOT NULL, error TEXT
    )`)
    old.exec(`INSERT INTO decisions (id, created_at, trigger, symbol, llm_raw, outcome)
      VALUES ('old', '2026-10-01T00:00:00.000Z', 'schedule', 'BTCUSDT', '{"decision":"approve"}', 'filled')`)
    old.close()

    const store = new Store(path)
    expect(store.getDecision('old')).toMatchObject({ llmRaw: '{"decision":"approve"}', llmCalls: null, llmPrompt: null })

    const prompt = { system: 's', user: 'u' }
    store.insertDecision({ id: 'new', createdAt: '2026-10-08T00:00:00.000Z', trigger: 'manual', symbol: 'BTCUSDT', outcome: 'hold', llmPrompt: prompt })
    expect(store.getDecision('new')!.llmPrompt).toEqual(prompt)
    store.close()

    // 再打开一次不会重复补列
    expect(() => new Store(path).close()).not.toThrow()
  })
})
