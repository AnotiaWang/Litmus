/**
 * 端到端：构建并启动真实的 Nuxt 服务，检查公开浏览 / 管理口令和主要的管理流程。
 * 不访问网络：服务启动时不会请求交易所和 LLM，只有定时任务触发时才会（测试结束前不会到点）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SEASON_CONFIG } from '../../shared/settings'
import { BASELINE_COLOR } from '../../shared/agents'
import { Store } from '../../server/lib/db'
import type { AgentAdminView, ProviderView, SeasonSummary, StandingsResponse } from '../../shared/types/api'

const TOKEN = 'e2e-admin-token-0123456789'
const LLM_KEY = 'sk-e2e-provider-key-0123456789'

/** 预先建好数据库，把检查间隔设成一天，测试期间不会触发定时任务去访问交易所 */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'litmus-e2e-'))
  const store = new Store(join(dir, 'litmus.db'))
  store.insertAgent({ kind: 'baseline', name: '均线基线', color: BASELINE_COLOR }, new Date())
  store.startSeason('第 1 赛季', { ...DEFAULT_SEASON_CONFIG, checkIntervalMinutes: 1440 }, new Date())
  store.close()
  return dir
}

describe('公开浏览与管理', async () => {
  await setup({
    rootDir: join(import.meta.dirname, '../..'),
    server: true,
    browser: false,
    // 构建时 Nuxt 会读取项目里的 .env，测试依赖的值都在这里显式指定，避免受本地配置影响
    env: {
      ADMIN_TOKEN: TOKEN,
      DATA_DIR: dataDir()
    }
  })

  const auth = { Authorization: `Bearer ${TOKEN}` }
  const json = { ...auth, 'Content-Type': 'application/json' }
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = json) =>
    fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })

  it('/healthz 无需口令', async () => {
    expect(await $fetch('/healthz')).toEqual({ ok: true })
  })

  it('/api/session 始终可以访问，告诉前端是否公开、口令是否正确', async () => {
    expect(await $fetch('/api/session')).toEqual({ publicRead: true, admin: false })
    expect(await $fetch('/api/session', { headers: auth })).toEqual({ publicRead: true, admin: true })
    expect(await $fetch('/api/session', { headers: { Authorization: 'Bearer wrong-token-0123456789' } })).toEqual({ publicRead: true, admin: false })
  })

  it('公开浏览：只读接口不需要口令；还没运行过时数据为空', async () => {
    const status = await $fetch<Record<string, unknown>>('/api/status')
    expect(status).toMatchObject({ running: false, paused: false, lastTick: null, season: { name: '第 1 赛季' } })
    expect(status.nextRunAt).toMatch(/^\d{4}-/)
    const seasons = await $fetch<SeasonSummary[]>('/api/seasons')
    expect(seasons).toHaveLength(1)
    const standings = await $fetch<StandingsResponse>('/api/standings')
    expect(standings).toMatchObject({ asOf: null, standings: [{ agent: { kind: 'baseline', name: '均线基线' }, equity: null }] })
    expect(await $fetch('/api/decisions')).toEqual({ items: [], total: 0 })
    expect(await $fetch('/api/equity?days=7')).toEqual({ seasonId: seasons[0]!.id, points: [], startPrice: null, base: { price: null, values: {} }, trades: [], intervalMs: 1440 * 60_000 })
    expect((await fetch('/api/decisions/not-exist')).status).toBe(404)
    expect((await fetch('/api/decisions?limit=999')).status).toBe(400)
    expect((await fetch('/api/standings?season=999')).status).toBe(404)
  })

  it.each([
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings'],
    ['POST', '/api/admin/pause'],
    ['POST', '/api/admin/resume'],
    ['POST', '/api/admin/run-once'],
    ['GET', '/api/admin/providers'],
    ['POST', '/api/admin/providers'],
    ['GET', '/api/admin/agents'],
    ['POST', '/api/admin/agents'],
    ['GET', '/api/admin/health'],
    ['POST', '/api/admin/seasons'],
    ['PATCH', '/api/admin/seasons/1']
  ])('%s %s 未带口令返回 401', async (method, path) => {
    expect((await fetch(path, { method })).status).toBe(401)
  })

  it('口令错误或格式不对返回 401', async () => {
    expect((await fetch('/api/admin/settings', { headers: { Authorization: 'Bearer wrong-token-0123456789' } })).status).toBe(401)
    expect((await fetch('/api/admin/settings', { headers: { Authorization: TOKEN } })).status).toBe(401)
  })

  it('Provider 和模型：Key 只以打码形式返回；模型自动加入当前赛季', async () => {
    const res = await send('POST', '/api/admin/providers', { name: 'E2E', baseUrl: 'http://127.0.0.1:9/v1', apiKey: LLM_KEY })
    expect(res.status).toBe(200)
    const provider = await res.json() as ProviderView
    expect(provider.apiKeyMasked).toBe('sk-e…6789')

    const listText = await (await fetch('/api/admin/providers', { headers: auth })).text()
    expect(listText).not.toContain(LLM_KEY)

    const bad = await send('POST', '/api/admin/agents', { providerId: provider.id, model: '', name: 'x' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).message).toContain('model')

    const agent = await $fetch<AgentAdminView>('/api/admin/agents', { method: 'POST', headers: auth, body: { providerId: provider.id, model: 'e2e-model', name: 'E2E 模型' } })
    expect(agent).toMatchObject({ kind: 'llm', model: 'e2e-model', status: 'active', deletable: true })
    const standings = await $fetch<StandingsResponse>('/api/standings')
    expect(standings.standings.map(s => s.agent.name)).toContain('E2E 模型')

    // 下面还有模型时不能删除 Provider
    expect((await send('DELETE', `/api/admin/providers/${provider.id}`)).status).toBe(409)
    // 公开数据里不出现 Provider 地址和 Key
    for (const path of ['/api/standings', '/api/status', '/api/seasons']) {
      const text = await (await fetch(path)).text()
      for (const secret of [LLM_KEY, '127.0.0.1:9', TOKEN]) expect(text).not.toContain(secret)
    }

    expect((await send('DELETE', `/api/admin/agents/${agent.id}`)).status).toBe(200)
    expect((await send('DELETE', `/api/admin/providers/${provider.id}`)).status).toBe(200)
  })

  it('暂停 / 恢复', async () => {
    expect(await $fetch('/api/admin/pause', { method: 'POST', headers: auth })).toMatchObject({ paused: true })
    expect(await $fetch('/api/status')).toMatchObject({ paused: true })
    expect(await $fetch('/api/admin/resume', { method: 'POST', headers: auth })).toMatchObject({ paused: false })
  })

  it('开始新赛季：配置不合法时返回 400；成功后成为当前赛季', async () => {
    const bad = await send('POST', '/api/admin/seasons', { config: { symbol: 'btc' } })
    expect(bad.status).toBe(400)
    expect((await bad.json()).message).toContain('symbol')

    const season = await $fetch<SeasonSummary>('/api/admin/seasons', { method: 'POST', headers: auth, body: { config: { checkIntervalMinutes: 1440, riskPreset: 'conservative' } } })
    expect(season).toMatchObject({ name: '第 2 赛季', endedAt: null, config: { riskPreset: 'conservative', initialCapital: '1500' } })
    expect(await $fetch('/api/status')).toMatchObject({ season: { id: season.id } })
    const renamed = await $fetch<SeasonSummary>(`/api/admin/seasons/${season.id}`, { method: 'PATCH', headers: auth, body: { name: '秋季赛' } })
    expect(renamed.name).toBe('秋季赛')
    expect((await $fetch<SeasonSummary[]>('/api/seasons')).map(s => s.name)).toEqual(['秋季赛', '第 1 赛季'])
  })

  // 放在最后：关掉公开浏览后，其他用例的只读请求都需要口令
  it('关闭公开浏览后，只读接口也需要口令', async () => {
    expect(await $fetch('/api/admin/settings', { method: 'PUT', headers: auth, body: { app: { publicRead: false } } })).toEqual({ app: { publicRead: false } })
    expect(await $fetch('/api/session')).toEqual({ publicRead: false, admin: false })
    for (const path of ['/api/status', '/api/standings', '/api/seasons', '/api/equity', '/api/decisions']) {
      expect((await fetch(path)).status).toBe(401)
      expect((await fetch(path, { headers: auth })).status).toBe(200)
    }
  })
})
