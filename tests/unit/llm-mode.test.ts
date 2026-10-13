/** LLM 决策模式：用模拟交易所和模拟 LLM 跑完整决策循环 */
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { flatCloses, makeKlines, NOW, setup, type SettingsOverrides } from './helpers'

const act = (action: 'buy' | 'sell' | 'hold', pct = 0) => `{"action":"${action}","size_pct":${pct},"confidence":0.7,"reason":"测试${action}"}`

const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000)

function llmSetup(llm: Array<string | Error> | null, settings: SettingsOverrides = {}) {
  return setup({ llm, settings: { decisionMode: 'llm', cooldownMinutes: 0, ...settings } })
}

/** 时间推进到 at，K 线换成在 at 之前收盘的一组（现价不变） */
function advance(env: ReturnType<typeof setup>, at: Date) {
  env.setNow(at)
  env.exchange.klines = makeKlines(flatCloses(), at.getTime() - 1000)
}

async function run(env: ReturnType<typeof setup>, trigger: 'schedule' | 'manual' = 'schedule') {
  const r = await env.engine.runOnce(trigger)
  if (r.status !== 'done') throw new Error('unexpected busy')
  return { ...r, decision: env.store.getDecision(r.decisionId)! }
}

describe('LLM 决策模式', () => {
  it('LLM 决定买入：按它给的比例下单，不计算规则指标；提示词里有账本、K 线和能否买卖', async () => {
    const env = llmSetup([act('buy', 40)])
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ mode: 'llm', signal: 'buy', signalNote: null, indicators: null, llmDecision: 'buy', llmSizePct: 40, orderQuoteAmount: '40' })
    expect(env.reviewer!.calls).toHaveLength(0)
    const input = env.reviewer!.decideCalls[0]!
    expect(input.klines).toHaveLength(48)
    expect(input).toMatchObject({ position: null, blocked: { buy: null, sell: '空仓，没有可卖的币' }, cadence: '每根 1h K 线收盘后' })
    expect(decision.llmPrompt!.user).toContain('可用 100 USDT')
    expect(decision.llmPrompt!.user).toContain('现在能否卖出：不可以（空仓，没有可卖的币）')
  })

  it('观望：不下单', async () => {
    const env = llmSetup([act('hold', 30)])
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('hold')
    expect(decision).toMatchObject({ signal: 'hold', llmDecision: 'hold', llmSizePct: 0 })
    expect(env.exchange.orders).toHaveLength(0)
  })

  it('每根 K 线只问一次：同一根 K 线的后续轮次只检查止损，新 K 线收盘后再问；手动运行不受限制', async () => {
    const env = llmSetup([act('hold')])
    await run(env)
    env.setNow(minutesLater(15))
    const skipped = await run(env)
    expect(skipped.outcome).toBe('hold')
    expect(skipped.decision.signalNote).toContain('已经问过 LLM，下次在 2026-10-08 13:00 UTC 之后')
    expect(skipped.decision.llmDecision).toBeNull()
    expect(env.reviewer!.decideCalls).toHaveLength(1)

    await run(env, 'manual')
    expect(env.reviewer!.decideCalls).toHaveLength(2)

    advance(env, minutesLater(60))
    await run(env)
    expect(env.reviewer!.decideCalls).toHaveLength(3)
  })

  it('固定间隔：按整点对齐的每 N 分钟问一次', async () => {
    const env = llmSetup([act('hold')], { llmCadence: 'interval', llmIntervalMinutes: 30 })
    await run(env)
    env.setNow(minutesLater(15))
    expect((await run(env)).decision.signalNote).toContain('每 30 分钟一次')
    env.setNow(minutesLater(30))
    await run(env)
    expect(env.reviewer!.decideCalls).toHaveLength(2)
  })

  it('LLM 没给出合法结果：观望，这个时段不算问过，下一轮重试', async () => {
    const env = llmSetup(['不是 JSON', '{"action":"buy","size_pct":0,"confidence":0.5,"reason":"x"}', act('hold')])
    const first = await run(env)
    expect(first.outcome).toBe('hold')
    expect(first.decision).toMatchObject({ signal: 'hold', llmDecision: 'hold', llmReason: '程序代为观望：LLM 未返回合法结果' })
    expect(first.decision.signalNote).toContain('下一轮重试')
    expect(first.decision.error).toMatch(/size_pct/)
    env.setNow(minutesLater(15))
    const retry = await run(env)
    expect(retry.decision).toMatchObject({ llmDecision: 'hold', signalNote: null })
    expect(env.reviewer!.decideCalls).toHaveLength(2)
  })

  it('部分卖出：按比例卖出持币，持仓成本按比例减少；之前的决策和成交会发给 LLM', async () => {
    const env = llmSetup([act('buy', 50), act('sell', 50)])
    await run(env)
    const before = { base: env.store.getLedger()!.base, cost: env.store.getPosition()!.cost }
    advance(env, minutesLater(60))
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'sell', orderSide: 'SELL', llmSizePct: 50 })
    const input = env.reviewer!.decideCalls[1]!
    expect(input.position).not.toBeNull()
    // 买入 50 USDT 后已到默认的 50% 仓位上限
    expect(input.blocked).toMatchObject({ buy: expect.stringContaining('仓位上限'), sell: null })
    expect(input.recentDecisions).toMatchObject([{ action: 'buy', sizePct: 50, outcome: 'filled' }])
    expect(input.recentFills).toMatchObject([{ side: 'buy' }])
    expect(Number.isFinite(input.indicators.smaFast)).toBe(true)
    expect(input.stats.hours).toBeGreaterThan(0)
    expect(Number(input.limits.minOrderUsdt)).toBeGreaterThan(0)
    const after = { base: env.store.getLedger()!.base, cost: env.store.getPosition()!.cost }
    expect(after.base.lt(before.base)).toBe(true)
    expect(after.cost.toFixed()).toBe(before.cost.mul(after.base).div(before.base).toFixed())
  })

  it('止损由程序每轮检查：跌破止损线直接全部卖出，不问 LLM', async () => {
    const env = llmSetup([act('buy', 40)])
    await run(env)
    const entry = env.store.getPosition()!.cost.div(env.store.getLedger()!.base)
    env.setNow(minutesLater(15))
    env.exchange.price = entry.mul('0.94').toDecimalPlaces(2)
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'sell', llmDecision: null, orderSide: 'SELL' })
    expect(decision.signalNote).toMatch(/^止损/)
    expect(env.reviewer!.decideCalls).toHaveLength(1)
    expect(env.store.getPosition()).toBeNull()
  })

  it('既不能买入也没有持仓可卖时不问 LLM，也不算问过', async () => {
    const env = llmSetup([act('hold')], { budgetUsdt: '3' })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('hold')
    expect(decision.signalNote).toContain('本轮不询问 LLM')
    expect(env.reviewer!.decideCalls).toHaveLength(0)
    expect(env.store.getLlmSlot()).toBeNull()
  })

  it('持仓时不能买入（冷却中）：照常询问，并告诉 LLM 不能买入的原因', async () => {
    const env = llmSetup([act('buy', 40), act('hold')], { cooldownMinutes: 120 })
    await run(env)
    advance(env, minutesLater(60))
    await run(env)
    expect(env.reviewer!.decideCalls[1]!.blocked.buy).toContain('交易冷却时间')
  })

  it('手动暂停时不问 LLM、不下单', async () => {
    const env = llmSetup([act('buy', 40)])
    env.engine.pause()
    const { outcome } = await run(env)
    expect(outcome).toBe('paused')
    expect(env.reviewer!.decideCalls).toHaveLength(0)
  })

  it('没有配置 LLM 时本轮出错，但止损照常执行', async () => {
    const env = llmSetup(null)
    expect((await run(env)).decision.error).toContain('LLM 决策模式需要')
    env.store.setInitial({ budget: '100', price: '50000', at: NOW.toISOString() })
    env.store.setLedger({ usdt: new Decimal(50), base: new Decimal('0.001') })
    env.store.setPosition({ cost: new Decimal(60), peak: new Decimal(60000) })
    env.setNow(minutesLater(15))
    const stop = await run(env)
    expect(stop.outcome).toBe('filled')
    expect(stop.decision.signalNote).toMatch(/^止损/)
  })
})
