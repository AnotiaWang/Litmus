/**
 * 端到端：构建并启动真实的 Nuxt 服务，检查接口鉴权。
 * 不访问网络：服务启动时不会请求交易所，只有定时任务触发时才会（测试结束前不会到点）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { Store } from '../../server/lib/db'
import type { SettingsResponse } from '../../shared/types/api'

const TOKEN = 'e2e-admin-token-0123456789'

/** 预先把运行间隔设成一天，测试期间不会触发定时任务去访问交易所 */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'litmus-e2e-'))
  const store = new Store(join(dir, 'litmus.db'))
  store.setSettings({ ...DEFAULT_SETTINGS, intervalMinutes: 1440 })
  store.close()
  return dir
}

describe('接口鉴权', async () => {
  await setup({
    rootDir: join(import.meta.dirname, '../..'),
    server: true,
    browser: false,
    // 构建时 Nuxt 会读取项目里的 .env，测试依赖的值都在这里显式指定，避免受本地配置影响
    env: {
      SYMBOL: 'BTCUSDT',
      BINANCE_ENV: 'demo',
      BINANCE_API_KEY: 'e2e-binance-key',
      BINANCE_API_SECRET: 'e2e-binance-secret',
      LLM_BASE_URL: '',
      LLM_API_KEY: '',
      LLM_MODEL: '',
      ADMIN_TOKEN: TOKEN,
      DATA_DIR: dataDir()
    }
  })

  const auth = { Authorization: `Bearer ${TOKEN}` }

  it('/healthz 无需口令', async () => {
    expect(await $fetch('/healthz')).toEqual({ ok: true })
  })

  it.each([
    ['GET', '/api/status'],
    ['GET', '/api/account'],
    ['GET', '/api/equity'],
    ['GET', '/api/decisions'],
    ['GET', '/api/decisions/abc'],
    ['POST', '/api/pause'],
    ['POST', '/api/resume'],
    ['POST', '/api/run-once'],
    ['GET', '/api/settings'],
    ['PUT', '/api/settings']
  ])('%s %s 未带口令返回 401', async (method, path) => {
    expect((await fetch(path, { method })).status).toBe(401)
  })

  it('口令错误返回 401', async () => {
    const res = await fetch('/api/status', { headers: { Authorization: 'Bearer wrong-token-0123456789' } })
    expect(res.status).toBe(401)
    const res2 = await fetch('/api/status', { headers: { Authorization: TOKEN } })
    expect(res2.status).toBe(401)
  })

  it('口令正确时返回状态，且不包含任何 Key', async () => {
    const res = await fetch('/api/status', { headers: auth })
    expect(res.status).toBe(200)
    const text = await res.text()
    const status = JSON.parse(text)
    expect(status).toMatchObject({ paused: false, mode: 'demo', symbol: 'BTCUSDT', intervalMinutes: 1440, llmEnabled: false })
    expect(status.nextRunAt).toMatch(/^\d{4}-/)
    for (const secret of ['e2e-binance-key', 'e2e-binance-secret', TOKEN]) expect(text).not.toContain(secret)
  })

  it('暂停 / 恢复', async () => {
    expect(await $fetch('/api/pause', { method: 'POST', headers: auth })).toMatchObject({ paused: true, pauseSource: 'manual' })
    expect(await $fetch('/api/resume', { method: 'POST', headers: auth })).toMatchObject({ paused: false })
  })

  it('还没有运行过时，账户和决策列表为空', async () => {
    expect(await $fetch('/api/account', { headers: auth })).toMatchObject({ ready: false, budget: '100' })
    expect(await $fetch('/api/decisions', { headers: auth })).toEqual({ items: [], total: 0 })
    expect(await $fetch('/api/equity?days=7', { headers: auth })).toEqual({ points: [], intervalMs: 1440 * 60_000 })
    expect((await fetch('/api/decisions/not-exist', { headers: auth })).status).toBe(404)
    expect((await fetch('/api/decisions?limit=999', { headers: auth })).status).toBe(400)
  })

  it('读取和保存设置：保存后状态接口马上反映新设置', async () => {
    const before = await $fetch<SettingsResponse>('/api/settings', { headers: auth })
    // .env 里没配置 LLM：不能开启
    expect(before).toMatchObject({ llmConfigured: false, budgetLock: null, settings: { intervalMinutes: 1440, budgetUsdt: '100' } })

    const settings = { ...before.settings, llmEnabled: false, intervalMinutes: 720, smaFast: 10 }
    const saved = await $fetch<SettingsResponse>('/api/settings', { method: 'PUT', headers: auth, body: settings })
    expect(saved.settings).toMatchObject({ intervalMinutes: 720, smaFast: 10 })
    expect(await $fetch('/api/status', { headers: auth })).toMatchObject({ intervalMinutes: 720, llmEnabled: false, strategy: { smaFast: 10 } })
  })

  it('不合法的设置返回 400，并说明原因', async () => {
    const { settings } = await $fetch<SettingsResponse>('/api/settings', { headers: auth })
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, smaFast: 60, smaSlow: 50 })
    })
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('smaFast')
    const res2 = await fetch('/api/settings', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, llmEnabled: true })
    })
    expect(res2.status).toBe(400)
  })
})
