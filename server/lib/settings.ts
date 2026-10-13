/**
 * 修改面板里的设置：校验 → 改预算时确认可以重新开始账本 → 保存 → 改了运行间隔时重新排定下次运行。
 *
 * 修改预算 = 重新开始策略账本（收益率、资产曲线从下一轮重新算）。为了不丢掉持仓的记账，有这些限制：
 * - 持仓期间不能改，要等策略卖出回到空仓
 * - 正在运行一轮时不能改
 * - Demo 账户里可用的 USDT 必须不少于新预算，否则下一轮核对账本时会自动暂停
 */
import Decimal from 'decimal.js'
import { settingsSchema, type Settings } from '../../shared/settings'
import type { SettingsResponse } from '../../shared/types/api'
import type { EnvConfig } from './config'
import type { Store } from './db'
import type { Engine } from './engine'
import type { Exchange } from './exchange'
import { log as defaultLog, redact, type Logger } from './logger'

export interface SettingsDeps {
  env: EnvConfig
  store: Store
  exchange: Pick<Exchange, 'getBalances'>
  engine: Pick<Engine, 'isRunning'>
  reschedule: () => void
  logger?: Logger
}

/** 带 HTTP 状态码的错误，接口层原样返回给面板 */
export class SettingsError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
  }
}

/** 现在不能修改预算的原因；可以修改时为 null */
export function budgetLock({ store, engine }: Pick<SettingsDeps, 'store' | 'engine'>): string | null {
  if (engine.isRunning) return '正在运行一轮决策，请等这一轮结束后再修改预算'
  if (store.getPosition()) return '策略当前持有仓位。修改预算会重新开始策略账本，请等策略卖出、回到空仓后再修改'
  return null
}

export function settingsView(deps: Pick<SettingsDeps, 'env' | 'store' | 'engine'>): SettingsResponse {
  return {
    settings: deps.store.getSettings(),
    llmConfigured: deps.env.llm.configured,
    budgetLock: budgetLock(deps)
  }
}

export async function updateSettings(deps: SettingsDeps, input: unknown): Promise<Settings> {
  const { env, store, exchange } = deps
  const log = deps.logger ?? defaultLog

  const parsed = settingsSchema.safeParse(input)
  if (!parsed.success) {
    throw new SettingsError(parsed.error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('；'), 400)
  }
  const next = parsed.data
  if (next.llmEnabled && !env.llm.configured) {
    throw new SettingsError('.env 里没有配置 LLM 连接信息（LLM_BASE_URL、LLM_API_KEY、LLM_MODEL），不能开启 LLM', 400)
  }
  if (next.decisionMode === 'llm' && !env.llm.configured) {
    throw new SettingsError('.env 里没有配置 LLM 连接信息（LLM_BASE_URL、LLM_API_KEY、LLM_MODEL），不能使用 LLM 决策模式', 400)
  }

  const prev = store.getSettings()
  const budgetChanged = !new Decimal(next.budgetUsdt).eq(prev.budgetUsdt)
  if (budgetChanged) {
    const lock = budgetLock(deps)
    if (lock) throw new SettingsError(lock, 409)
    let free: Decimal
    try {
      free = (await exchange.getBalances()).USDT?.free ?? new Decimal(0)
    } catch (e) {
      throw new SettingsError(`查询 Demo 账户余额失败，设置没有保存：${redact((e as Error).message)}`, 502)
    }
    if (free.lt(next.budgetUsdt)) {
      throw new SettingsError(`Demo 账户可用 ${free.toFixed(2)} USDT，少于新预算 ${next.budgetUsdt} USDT`, 400)
    }
    // 查询余额期间可能开始了新的一轮（甚至已经买入），保存前再确认一次。之后都是同步操作，不会再被打断
    const lockAfter = budgetLock(deps)
    if (lockAfter) throw new SettingsError(lockAfter, 409)
  }

  store.transaction(() => {
    store.setSettings(next)
    if (budgetChanged) store.resetLedger()
  })

  const changes = (Object.keys(next) as Array<keyof Settings>)
    .filter(k => String(next[k]) !== String(prev[k]))
    .map(k => `${k} ${prev[k]} → ${next[k]}`)
  if (changes.length) log.info(`设置已更新：${changes.join('，')}`)
  if (budgetChanged) log.info(`预算改为 ${next.budgetUsdt} USDT，策略账本将在下一轮重新开始`)
  if (next.intervalMinutes !== prev.intervalMinutes) deps.reschedule()
  return next
}
