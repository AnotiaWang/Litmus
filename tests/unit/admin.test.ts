/** 管理操作（Provider、模型、赛季、站点设置）和公开接口的数据组装 */
import Decimal from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_COLORS } from '../../shared/agents'
import { DEFAULT_SEASON_CONFIG, RISK_PRESETS } from '../../shared/settings'
import { AdminError, archiveAgent, bootstrap, createAgent, createProvider, deleteAgent, deleteProvider, listAgentsAdmin, listProvidersView, maskKey, renameSeason, startSeason, testAgent, updateAgent, updateAppSettings, updateProvider, type AdminDeps } from '../../server/lib/admin'
import { Store } from '../../server/lib/db'
import { equityView, standingsView, statusView } from '../../server/lib/views'
import { minutesLater, NOW, PROVIDER_KEY, run, setup, silentLogger, uptrendCloses, type Env } from './helpers'

const hold = '{"action":"hold","size_pct":0,"confidence":0.5,"reason":"等等"}'

function admin(env: Env, overrides: Partial<AdminDeps> = {}): AdminDeps & { refreshSecrets: ReturnType<typeof vi.fn>, reschedule: ReturnType<typeof vi.fn> } {
  return {
    store: env.store,
    engine: env.engine,
    market: env.market,
    deciderFor: a => env.llms.get(a.id)!,
    refreshSecrets: vi.fn(),
    reschedule: vi.fn(),
    logger: silentLogger,
    now: () => minutesLater(1),
    ...overrides
  } as AdminDeps & { refreshSecrets: ReturnType<typeof vi.fn>, reschedule: ReturnType<typeof vi.fn> }
}

/** 断言抛出指定状态码的 AdminError，返回错误信息 */
function adminError(fn: () => unknown, status: number): string {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AdminError)
    expect((e as AdminError).statusCode).toBe(status)
    return (e as Error).message
  }
  throw new Error('没有抛错')
}

describe('第一次启动', () => {
  it('空数据库：建一个均线基线，开始第 1 赛季（默认配置）；再启动不会重复建', () => {
    const store = new Store(':memory:')
    bootstrap(store, NOW)
    bootstrap(store, NOW)
    expect(store.listAgents()).toMatchObject([{ kind: 'baseline', name: '均线基线', status: 'active' }])
    expect(store.listSeasons()).toHaveLength(1)
    const season = store.currentSeason()!
    expect(season).toMatchObject({ name: '第 1 赛季', config: DEFAULT_SEASON_CONFIG })
    expect(store.listEntries(season.id)).toHaveLength(1)
  })

  it('默认赛季配置：BTCUSDT，每个模型 1500 USDT，1h 决策，每 15 分钟检查止损，激进预设', () => {
    expect(DEFAULT_SEASON_CONFIG).toEqual({
      symbol: 'BTCUSDT',
      initialCapital: '1500',
      klineInterval: '1h',
      checkIntervalMinutes: 15,
      llmKlines: 48,
      riskPreset: 'aggressive',
      risk: RISK_PRESETS.aggressive
    })
  })
})

describe('Provider', () => {
  it('新建：校验输入，Key 打码返回，重新登记日志打码', () => {
    const env = setup()
    const deps = admin(env)
    expect(adminError(() => createProvider(deps, { name: '', baseUrl: 'x', apiKey: '' }), 400)).toMatch(/name.*baseUrl.*apiKey/)
    const p = createProvider(deps, { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-or-v1-abcdefghijklmnop' })
    expect(p).toMatchObject({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyMasked: 'sk-o…mnop', agentCount: 0 })
    expect(JSON.stringify(listProvidersView(env.store))).not.toContain('abcdefghijklmnop')
    expect(deps.refreshSecrets).toHaveBeenCalledTimes(1)
  })

  it('修改：Key 留空表示不改；不存在时 404', () => {
    const env = setup()
    const deps = admin(env)
    const p = createProvider(deps, { name: 'A', baseUrl: 'https://a.example/v1', apiKey: 'key-0000-1111-2222' })
    updateProvider(deps, p.id, { name: 'A2', baseUrl: 'https://a2.example/v1', apiKey: '' })
    expect(env.store.getProvider(p.id)).toMatchObject({ name: 'A2', baseUrl: 'https://a2.example/v1', apiKey: 'key-0000-1111-2222' })
    updateProvider(deps, p.id, { name: 'A2', baseUrl: 'https://a2.example/v1', apiKey: 'key-new-3333-4444' })
    expect(env.store.getProvider(p.id)!.apiKey).toBe('key-new-3333-4444')
    adminError(() => updateProvider(deps, 999, { name: 'x', baseUrl: 'https://x', apiKey: 'k' }), 404)
  })

  it('下面还有模型（含已归档）时不能删除', () => {
    const env = setup({ llm: [hold] })
    const deps = admin(env)
    expect(adminError(() => deleteProvider(deps, env.providerId!), 409)).toContain('还有模型')
    const p = createProvider(deps, { name: 'B', baseUrl: 'https://b.example/v1', apiKey: 'key-0000-1111-2222' })
    deleteProvider(deps, p.id)
    expect(env.store.getProvider(p.id)).toBeNull()
  })

  it('打码：保留首尾 4 位，太短时全部打码', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-1…cdef')
    expect(maskKey('short-key')).toBe('***')
  })
})

describe('模型', () => {
  const input = (env: Env, extra: Record<string, unknown> = {}) => ({ providerId: env.providerId, model: 'gpt-x', name: 'GPT X', ...extra })

  it('新建：自动加入当前赛季；没指定颜色时取第一个没被占用的', () => {
    const env = setup({ llm: [hold] })
    const deps = admin(env)
    const a = createAgent(deps, input(env, { reasoningEffort: 'high', extraParams: { top_p: 0.9 } }))
    expect(a).toMatchObject({ kind: 'llm', model: 'gpt-x', provider: '测试服务', reasoningEffort: 'high', timeoutSeconds: 120, extraParams: { top_p: 0.9 }, status: 'active', deletable: true })
    // setup 里的模型占了第一个颜色
    expect(a.color).toBe(AGENT_COLORS[1])
    expect(env.store.listEntries(env.season.id).map(e => e.agentId)).toContain(a.id)
  })

  it('校验输入：必填项、Provider 存在、额外参数不能覆盖 model / messages', () => {
    const env = setup({ llm: [hold] })
    const deps = admin(env)
    adminError(() => createAgent(deps, { providerId: env.providerId, name: 'x' }), 400)
    adminError(() => createAgent(deps, input(env, { providerId: 999 })), 404)
    expect(adminError(() => createAgent(deps, input(env, { extraParams: { model: 'other' } })), 400)).toContain('不能覆盖')
    adminError(() => createAgent(deps, input(env, { timeoutSeconds: 1 })), 400)
  })

  it('修改：只能改显示名、颜色和超时，模型名等字段不变', () => {
    const env = setup({ llm: [hold] })
    const deps = admin(env)
    const a = updateAgent(deps, env.llmAgentId!, { name: '新名字', color: '#000000', timeoutSeconds: 300, model: 'changed' })
    expect(a).toMatchObject({ name: '新名字', color: '#000000', timeoutSeconds: 300, model: 'test-model' })
    adminError(() => updateAgent(deps, env.llmAgentId!, { name: 'x', color: 'red', timeoutSeconds: 60 }), 400)
  })

  it('没参与过运行的可以删除；参与过的只能归档，归档后不再参赛、成绩保留', async () => {
    const env = setup({ llm: [hold] })
    const deps = admin(env)
    const fresh = createAgent(deps, input(env))
    deleteAgent(deps, fresh.id)
    expect(env.store.getAgent(fresh.id)).toBeNull()

    await run(env)
    expect(listAgentsAdmin(env.store).find(a => a.id === env.llmAgentId)!.deletable).toBe(false)
    expect(adminError(() => deleteAgent(deps, env.llmAgentId!), 409)).toContain('只能归档')
    const archived = archiveAgent(deps, env.llmAgentId!)
    expect(archived).toMatchObject({ status: 'archived', archivedAt: minutesLater(1).toISOString() })
    expect(env.store.listEntries(env.season.id)[0]!.leftAt).toBe(minutesLater(1).toISOString())
    expect(standingsView(env.store, env.season).standings[0]).toMatchObject({ leftAt: minutesLater(1).toISOString(), equity: '100' })
  })

  it('正在运行一轮时不能归档或删除', () => {
    const env = setup({ llm: [hold] })
    const deps = admin(env, { engine: { isRunning: true } })
    adminError(() => archiveAgent(deps, env.llmAgentId!), 409)
    adminError(() => deleteAgent(deps, env.llmAgentId!), 409)
  })

  it('测试模型：用当前行情和空账本问一次，不记录、不交易；基线不需要测试', async () => {
    const env = setup({ llm: [hold], baseline: true })
    const deps = admin(env)
    const r = await testAgent(deps, env.llmAgentId!)
    expect(r).toMatchObject({ ok: true, action: 'hold', error: null })
    expect(r.calls).toHaveLength(1)
    expect(env.llm!.calls[0]).toMatchObject({ position: null, ledger: { usdt: '100', base: '0' }, recentDecisions: [] })
    expect(env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 10, offset: 0 }).total).toBe(0)
    await expect(testAgent(deps, env.baselineId!)).rejects.toThrow('不需要测试')
  })
})

describe('赛季', () => {
  it('开始新赛季：结束当前赛季，参赛中的模型按新配置从初始资金重新开始；预设展开成具体数值', async () => {
    const env = setup({ closes: uptrendCloses() })
    await run(env)
    expect(env.state().getPosition()).not.toBeNull()
    const archivedId = env.store.insertAgent({ kind: 'baseline', name: '已归档', color: '#000000' }, NOW)
    env.store.setAgentStatus(archivedId, 'archived', NOW)
    const deps = admin(env)

    const s = startSeason(deps, { config: { initialCapital: 2000, riskPreset: 'moderate', klineInterval: '4h' } })
    expect(s).toMatchObject({ name: '第 2 赛季', endedAt: null, config: { initialCapital: '2000', klineInterval: '4h', risk: RISK_PRESETS.moderate } })
    expect(env.store.getSeason(env.season.id)!.endedAt).toBe(minutesLater(1).toISOString())
    expect(env.store.listEntries(s.id).map(e => e.agentId)).toEqual([env.agentId])
    expect(deps.reschedule).toHaveBeenCalled()

    env.setNow(minutesLater(5))
    const r = await run(env)
    const state = env.store.entry(s.id, env.agentId)
    expect(state.getInitial()!.capital).toBe('2000')
    // 新赛季从空仓开始，同一个信号重新买入；上个赛季的持仓和记录留在上个赛季
    expect(r.decision).toMatchObject({ seasonId: s.id, outcome: 'filled', orderSide: 'buy' })
    expect(Number(state.getLedger()!.usdt.toFixed())).toBeGreaterThan(1000)
    expect(env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 10, offset: 0 }).total).toBe(1)
    expect(env.state().getPosition()).not.toBeNull()
  })

  it('配置不合法时不开始；正在运行一轮时不能开始；可以改名', () => {
    const env = setup()
    const deps = admin(env)
    expect(adminError(() => startSeason(deps, { config: { symbol: 'BTCETH' } }), 400)).toContain('symbol')
    adminError(() => startSeason(admin(env, { engine: { isRunning: true } }), { config: {} }), 409)
    expect(env.store.currentSeason()!.id).toBe(env.season.id)
    expect(startSeason(deps, { name: '  春季赛 ', config: {} }).name).toBe('春季赛')
    expect(renameSeason(deps, env.season.id, '测试赛季（旧）').name).toBe('测试赛季（旧）')
    adminError(() => renameSeason(deps, env.season.id, ' '), 400)
  })

  it('自定义风控按填的值保存；保存下来的配置不会被之后修改的预设定义影响', () => {
    const env = setup()
    const s = startSeason(admin(env), { config: { riskPreset: 'custom', risk: { ...RISK_PRESETS.conservative, cooldownMinutes: 5 } } })
    expect(s.config.risk).toEqual({ ...RISK_PRESETS.conservative, cooldownMinutes: 5 })
    // 模拟“预设定义改了”：库里存的是展开后的数值，读出来不变
    env.store.db.prepare('UPDATE seasons SET config = ? WHERE id = ?').run(JSON.stringify({ ...s.config, riskPreset: 'aggressive', risk: { ...RISK_PRESETS.aggressive, stopLossPct: 42 } }), s.id)
    expect(env.store.getSeason(s.id)!.config.risk.stopLossPct).toBe(42)
  })
})

describe('站点设置', () => {
  it('公开浏览默认开启，可以关闭', () => {
    const env = setup()
    expect(env.store.getAppSettings()).toEqual({ publicRead: true })
    updateAppSettings(admin(env), { publicRead: false })
    expect(env.store.getAppSettings()).toEqual({ publicRead: false })
    adminError(() => updateAppSettings(admin(env), { publicRead: 'no' }), 400)
  })
})

describe('公开数据', () => {
  it('排行榜：按收益率排序，带收益、一直持有基准、回撤、成交和 LLM 统计；不含 Provider 地址和 Key', async () => {
    const env = setup({ closes: uptrendCloses(), llm: ['{"action":"buy","size_pct":20,"confidence":0.5,"reason":"试试"}'], baseline: true })
    await run(env)
    env.setNow(minutesLater(15))
    env.market.price = new Decimal(58300)
    await run(env)

    const view = standingsView(env.store, env.season, minutesLater(16))
    expect(view).toMatchObject({ asOf: minutesLater(15).toISOString(), price: '58300', benchmarkReturnPct: '10.00' })
    // 基线买得多，涨了以后排第一
    expect(view.standings.map(s => s.agent.id)).toEqual([env.baselineId, env.llmAgentId])
    const [baseline, llm] = view.standings
    expect(baseline).toMatchObject({ trades: 1, sells: 0, llm: null, benchmarkReturnPct: '10.00', maxDrawdownPct: '0.00', circuit: null })
    expect(Number(baseline!.returnPct)).toBeGreaterThan(Number(llm!.returnPct))
    expect(Number(baseline!.excessReturnPct)).toBeLessThan(0)
    expect(baseline!.entryPrice).not.toBeNull()
    expect(llm).toMatchObject({ trades: 1, agent: { provider: '测试服务', model: 'test-model' }, llm: { asked: 1, ok: 1, invalidOutput: 0, requestFailed: 0, promptTokens: 100, completionTokens: 20 } })
    expect(Number(llm!.feesUsdt)).toBeGreaterThan(0)
    const dump = JSON.stringify(view)
    expect(dump).not.toContain('llm.local')
    expect(dump).not.toContain(PROVIDER_KEY)
  })

  it('还没运行过时：排行榜的成绩为空，曲线没有点', () => {
    const env = setup()
    const view = standingsView(env.store, env.season)
    expect(view).toMatchObject({ asOf: null, price: null, benchmarkReturnPct: null })
    expect(view.standings[0]).toMatchObject({ equity: null, returnPct: null, maxDrawdownPct: null, trades: 0 })
    expect(equityView(env.store, env.season, 30, NOW)).toEqual({ seasonId: env.season.id, points: [], startPrice: null, base: { price: null, values: {} }, intervalMs: 15 * 60_000 })
  })

  it('资产曲线：每轮一个点，带价格和各模型的资产', async () => {
    const env = setup({ llm: [hold], baseline: true })
    await run(env)
    env.setNow(minutesLater(15))
    await run(env)
    const view = equityView(env.store, env.season, 1, minutesLater(16))
    expect(view.points).toHaveLength(2)
    expect(view.startPrice).toBe('50020')
    expect(view.points[0]).toEqual({ t: NOW.toISOString(), price: '50020', values: { [env.llmAgentId!]: '100', [env.baselineId!]: '100' } })
    // 范围覆盖了赛季开头：没有起点值，前端按初始资金和赛季起始价算
    expect(view.base).toEqual({ price: null, values: {} })
    // 范围从第二轮开始：起点是第一轮的价格和资产
    const later = equityView(env.store, env.season, 1, new Date(minutesLater(10).getTime() + 86_400_000))
    expect(later.points).toHaveLength(1)
    expect(later.base).toEqual({ price: '50020', values: { [env.llmAgentId!]: '100', [env.baselineId!]: '100' } })
  })

  it('状态：运行间隔、上一轮、暂停和当前赛季', async () => {
    const env = setup()
    await run(env)
    env.engine.pause()
    expect(statusView({ store: env.store, engine: env.engine, nextRunAt: 'x' })).toMatchObject({
      running: false,
      paused: true,
      nextRunAt: 'x',
      lastTick: { at: NOW.toISOString(), error: null },
      season: { id: env.season.id, name: '测试赛季' }
    })
  })
})
