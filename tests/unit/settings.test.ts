import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, settingsSchema } from '../../shared/settings'
import { readStoredSettings, Store } from '../../server/lib/db'
import { budgetLock, SettingsError, settingsView, updateSettings, type SettingsDeps } from '../../server/lib/settings'
import { equityView, statusView } from '../../server/lib/views'
import { BASE_ENV, goldenCrossCloses, NOW, setup } from './helpers'
import { loadEnvConfig } from '../../server/lib/config'

const silent = { info: () => {}, warn: () => {}, error: () => {} }

function deps(env: ReturnType<typeof setup>, overrides: Partial<SettingsDeps> = {}) {
  let rescheduled = 0
  const d: SettingsDeps = {
    env: loadEnvConfig(BASE_ENV),
    store: env.store,
    exchange: env.exchange,
    engine: env.engine,
    reschedule: () => {
      rescheduled++
    },
    logger: silent,
    ...overrides
  }
  return { d, rescheduled: () => rescheduled }
}

async function rejection(p: Promise<unknown>): Promise<SettingsError> {
  try {
    await p
  } catch (e) {
    if (e instanceof SettingsError) return e
    throw e
  }
  throw new Error('应当失败')
}

describe('设置项', () => {
  it('默认值与文档一致', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      budgetUsdt: '100',
      intervalMinutes: 15,
      decisionMode: 'rules',
      llmEnabled: true,
      llmCadence: 'candle',
      llmIntervalMinutes: 60,
      llmKlines: 48,
      klineInterval: '1h',
      signalMode: 'trend',
      confirmBars: 2,
      smaFast: 20,
      smaSlow: 50,
      rsiPeriod: 14,
      rsiBuyMax: 70,
      rsiSellMin: 100,
      stopLossPct: 5,
      trailingStopPct: 0,
      maxOrderUsdt: '50',
      maxPositionPct: 50,
      maxTradesPerDay: 6,
      cooldownMinutes: 60,
      dailyLossLimitPct: 5
    })
  })

  it('金额可以填数字，统一存成字符串；校验范围', () => {
    expect(settingsSchema.parse({ budgetUsdt: 500, maxOrderUsdt: '25.5' })).toMatchObject({ budgetUsdt: '500', maxOrderUsdt: '25.5' })
    expect(settingsSchema.safeParse({ budgetUsdt: '-1' }).success).toBe(false)
    expect(settingsSchema.safeParse({ budgetUsdt: 0 }).success).toBe(false)
    expect(settingsSchema.safeParse({ intervalMinutes: 0 }).success).toBe(false)
    expect(settingsSchema.safeParse({ smaFast: 60 }).success).toBe(false)
    expect(settingsSchema.safeParse({ smaSlow: 99 }).success).toBe(false)
    expect(settingsSchema.safeParse({ signalMode: 'macd' }).success).toBe(false)
    expect(settingsSchema.safeParse({ trailingStopPct: -1 }).success).toBe(false)
    expect(settingsSchema.safeParse({ confirmBars: 0 }).success).toBe(false)
    expect(settingsSchema.safeParse({ confirmBars: 11 }).success).toBe(false)
    // 长期均线 + 确认根数不能超过取的 K 线根数（100）
    expect(settingsSchema.safeParse({ smaSlow: 98, confirmBars: 2 }).success).toBe(true)
    expect(settingsSchema.safeParse({ smaSlow: 98, confirmBars: 3 }).success).toBe(false)
  })

  it('数据库里没保存过的项用默认值', () => {
    const store = new Store(':memory:')
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    store.setSettings({ ...DEFAULT_SETTINGS, intervalMinutes: 5 })
    expect(store.getSettings().intervalMinutes).toBe(5)
  })

  it('旧库：账本已按环境变量里的预算初始化过，打开时把那笔预算写进设置', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'litmus-settings-')), 'litmus.db')
    const old = new Store(path)
    old.setInitial({ budget: '500', price: '80000', at: NOW.toISOString() })
    old.db.prepare(`DELETE FROM state WHERE key = 'settings'`).run()
    old.close()
    expect(readStoredSettings(path)).toBeNull()

    const store = new Store(path)
    expect(store.getSettings().budgetUsdt).toBe('500')
    store.close()
    expect(readStoredSettings(path)).toMatchObject({ budgetUsdt: '500' })
  })

  it('回测只读地取设置：数据库不存在时返回 null，也不会创建文件', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'litmus-settings-')), 'none.db')
    expect(readStoredSettings(path)).toBeNull()
    expect(() => readStoredSettings(path)).not.toThrow()
  })
})

describe('修改设置', () => {
  it('保存后下一轮生效；改了运行间隔会重新排定', async () => {
    const env = setup()
    const { d, rescheduled } = deps(env)
    await updateSettings(d, { ...DEFAULT_SETTINGS, intervalMinutes: 5, stopLossPct: 3 })
    expect(env.store.getSettings()).toMatchObject({ intervalMinutes: 5, stopLossPct: 3 })
    expect(env.config().strategy.stopLossPct).toBe(3)
    expect(rescheduled()).toBe(1)

    await updateSettings(d, { ...env.store.getSettings(), stopLossPct: 4 })
    expect(rescheduled()).toBe(1)
  })

  it('不合法的设置不保存，返回 400 并说明原因', async () => {
    const env = setup()
    const before = env.store.getSettings()
    const e = await rejection(updateSettings(deps(env).d, { ...DEFAULT_SETTINGS, smaFast: 50, smaSlow: 20 }))
    expect(e.statusCode).toBe(400)
    expect(e.message).toContain('smaFast')
    expect(env.store.getSettings()).toEqual(before)
  })

  it('.env 里没有配置 LLM 时不能使用 LLM 决策模式', async () => {
    const env = setup()
    const noLlm = loadEnvConfig({ ...BASE_ENV, LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' })
    const { d } = deps(env, { env: noLlm })
    const e = await rejection(updateSettings(d, { ...DEFAULT_SETTINGS, llmEnabled: false, decisionMode: 'llm' }))
    expect(e.statusCode).toBe(400)
    expect(e.message).toContain('LLM 决策模式')
  })

  it('切换决策方式和询问频率：下一轮生效，状态接口显示询问频率', async () => {
    const env = setup()
    await updateSettings(deps(env).d, { ...DEFAULT_SETTINGS, decisionMode: 'llm', llmCadence: 'interval', llmIntervalMinutes: 30 })
    expect(env.config().decision).toEqual({ mode: 'llm', llmCadence: 'interval', llmIntervalMinutes: 30, llmKlines: 48 })
    expect(statusView({ config: env.config, store: env.store, engine: env.engine, nextRunAt: null })).toMatchObject({ decisionMode: 'llm', llmCadence: '每 30 分钟' })
  })

  it('.env 里没有配置 LLM 时不能开启 LLM', async () => {
    const env = setup()
    const noLlm = loadEnvConfig({ ...BASE_ENV, LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' })
    const { d } = deps(env, { env: noLlm })
    expect((await rejection(updateSettings(d, DEFAULT_SETTINGS))).message).toMatch(/LLM/)
    await updateSettings(d, { ...DEFAULT_SETTINGS, llmEnabled: false })
    expect(settingsView(d)).toMatchObject({ llmConfigured: false, settings: { llmEnabled: false } })
  })

  it('修改预算：重新开始账本，下一轮按新预算初始化；资产曲线只画新的一期', async () => {
    const env = setup()
    await env.engine.runOnce('schedule')
    expect(env.store.getInitial()!.budget).toBe('100')
    expect(equityView(env.store, 30, NOW).points).toHaveLength(1)

    await updateSettings(deps(env).d, { ...DEFAULT_SETTINGS, budgetUsdt: '500' })
    expect(env.store.getInitial()).toBeNull()
    expect(env.store.getLedger()).toBeNull()
    expect(equityView(env.store, 30, NOW)).toEqual({ points: [], intervalMs: 15 * 60_000 })
    // 决策记录保留
    expect(env.store.listDecisions({ limit: 10, offset: 0, onlyActions: false }).total).toBe(1)

    const later = new Date(NOW.getTime() + 15 * 60_000)
    env.setNow(later)
    await env.engine.runOnce('schedule')
    expect(env.store.getInitial()).toMatchObject({ budget: '500', at: later.toISOString() })
    expect(env.store.getLedger()!.usdt.toFixed()).toBe('500')
    expect(equityView(env.store, 30, later).points.map(p => p.total)).toEqual(['500'])
  })

  it('持仓期间不能修改预算，其他设置照常保存', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: null, settings: { llmEnabled: false } })
    await env.engine.runOnce('schedule')
    expect(env.store.getPosition()).not.toBeNull()
    const { d } = deps(env)
    expect(settingsView(d).budgetLock).toMatch(/持有仓位/)

    const e = await rejection(updateSettings(d, { ...env.store.getSettings(), budgetUsdt: '500' }))
    expect(e.statusCode).toBe(409)
    expect(env.store.getInitial()!.budget).toBe('100')

    await updateSettings(d, { ...env.store.getSettings(), stopLossPct: 2 })
    expect(env.store.getSettings().stopLossPct).toBe(2)
  })

  it('正在运行一轮时不能修改预算', () => {
    const env = setup()
    expect(budgetLock({ store: env.store, engine: { isRunning: true } })).toMatch(/正在运行/)
  })

  it('Demo 账户可用余额不足或查询失败时不保存', async () => {
    const env = setup()
    env.exchange.balances = { USDT: { free: new Decimal(300), locked: new Decimal(0) } }
    const short = await rejection(updateSettings(deps(env).d, { ...DEFAULT_SETTINGS, budgetUsdt: '500' }))
    expect(short).toMatchObject({ statusCode: 400 })
    expect(short.message).toContain('300.00')

    const failing = { getBalances: () => Promise.reject(new Error('network down')) }
    const down = await rejection(updateSettings(deps(env, { exchange: failing }).d, { ...DEFAULT_SETTINGS, budgetUsdt: '200' }))
    expect(down).toMatchObject({ statusCode: 502 })
    expect(env.store.getSettings().budgetUsdt).toBe('100')
  })

  it('查询余额期间开始了一轮并买入：保存前再检查一次，不会丢掉持仓记账', async () => {
    const env = setup()
    const racing = {
      getBalances: async () => {
        // 模拟查询余额的同时，引擎完成了一笔买入
        env.store.setPosition({ cost: new Decimal(50), peak: new Decimal(50000) })
        return env.exchange.getBalances()
      }
    }
    const e = await rejection(updateSettings(deps(env, { exchange: racing }).d, { ...DEFAULT_SETTINGS, budgetUsdt: '200' }))
    expect(e.statusCode).toBe(409)
    expect(env.store.getSettings().budgetUsdt).toBe('100')
  })
})
