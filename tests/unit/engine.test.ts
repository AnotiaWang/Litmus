/** 用模拟行情跑完整的一轮：均线基线的决策流程，以及多个模型共用一份行情快照 */
import Decimal from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import { MarketError } from '../../server/lib/market'
import { downtrendCloses, flatCloses, makeKlines, minutesLater, NOW, run, setMarket, setup, uptrendCloses } from './helpers'

const fills = (env: ReturnType<typeof setup>) => env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 100, offset: 0 }).items.filter(d => d.outcome === 'filled')

describe('均线基线', () => {
  it('观望：建账本，记行情快照和资产快照，不写决策记录', async () => {
    const env = setup()
    const r = await run(env)
    expect(r).toMatchObject({ outcome: 'hold', decision: null, error: null })
    expect(env.state().getLedger()!.usdt.toFixed()).toBe('100')
    expect(env.state().getInitial()).toEqual({ capital: '100', price: '50020', at: NOW.toISOString() })
    expect(env.store.latestTick()).toMatchObject({ id: r.tickId, price: '50020', trigger: 'schedule', error: null })
    expect(env.store.latestEquity(env.season.id).get(env.agentId)).toMatchObject({ total: '100', price: '50020' })
    expect(env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 10, offset: 0 }).total).toBe(0)
  })

  it('买入成交：按快照价模拟成交，手续费以 USDT 收取；记录指标、风控和成交', async () => {
    const env = setup({ closes: uptrendCloses() })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'buy', orderSide: 'buy', orderQuoteAmount: '50', riskPassed: true, price: '53000', llmStatus: null, realizedPnl: null })
    expect(decision!.indicators!.rsi).toBeTypeOf('number')
    expect(decision!.signalNote).toContain('连续 2 根')
    // 50 / (53000 × 1.001) → 0.00094 BTC
    expect(decision!.filledQty).toBe('0.00094')
    expect(decision!.filledQuote).toBe('49.82')
    expect(decision!.feeUsdt).toBe('0.04982')
    const ledger = env.state().getLedger()!
    expect(ledger.usdt.toFixed()).toBe('50.13018')
    expect(ledger.base.toFixed()).toBe('0.00094')
    expect(env.state().getPosition()!.cost.toFixed()).toBe('49.86982')
  })

  it('卖出成交（趋势转弱）：全部卖出，记录已实现盈亏，清空持仓', async () => {
    const env = setup({ closes: uptrendCloses() })
    await run(env)
    setMarket(env, downtrendCloses(), minutesLater(61))
    env.setNow(minutesLater(61))
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'sell', orderSide: 'sell', orderQty: '0.00094', price: '49000' })
    // 卖得 0.00094 × 49000 = 46.06，扣 0.1% 手续费，减去成本 49.86982
    expect(decision!.realizedPnl).toBe(new Decimal('46.06').minus('0.04606').minus('49.86982').toFixed())
    expect(env.state().getPosition()).toBeNull()
    expect(env.state().getLedger()!.base.toFixed()).toBe('0')
  })

  it('同一根 K 线上的信号只处理一次（含被风控拦下的），换了新 K 线再出现才会再处理', async () => {
    const env = setup({ closes: uptrendCloses(), config: { initialCapital: '3' } })
    const first = await run(env)
    expect(first.outcome).toBe('risk_block')
    expect(first.decision).toMatchObject({ signal: 'buy', riskPassed: false, riskRule: 'no_funds' })
    env.setNow(minutesLater(15))
    expect(await run(env)).toMatchObject({ outcome: 'hold', decision: null })
    setMarket(env, uptrendCloses(), minutesLater(60))
    env.setNow(minutesLater(60))
    expect((await run(env)).outcome).toBe('risk_block')
    expect(env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 10, offset: 0 }).total).toBe(2)
  })

  it('出错（K 线不够算均线）时记录错误；不算处理过，补齐后同一根 K 线可以重试', async () => {
    const env = setup()
    env.market.klines = makeKlines(uptrendCloses().slice(-30), NOW.getTime() - 30_000)
    const first = await run(env)
    expect(first.outcome).toBe('error')
    expect(first.decision!.error).toContain('K 线数量不足')
    // 出错的模型照样记资产快照
    expect(env.store.latestEquity(env.season.id).get(env.agentId)!.total).toBe('100')
    env.market.klines = makeKlines(uptrendCloses(), NOW.getTime() - 30_000)
    env.setNow(minutesLater(5))
    expect((await run(env)).outcome).toBe('filled')
  })

  it('低于最小下单额的零头不算持仓，照常买入', async () => {
    const env = setup({ closes: uptrendCloses() })
    env.state().setInitial({ capital: '100', price: '50000', at: NOW.toISOString() })
    env.state().setLedger({ usdt: new Decimal(100), base: new Decimal('0.00001') })
    expect((await run(env)).outcome).toBe('filled')
  })

  it('单笔上限按总资产百分比；仓位上限把买入金额调小', async () => {
    const a = setup({ closes: uptrendCloses(), config: { risk: { maxOrderPct: 30, maxPositionPct: 100 } } })
    expect((await run(a)).decision!.orderQuoteAmount).toBe('30')
    const b = setup({ closes: uptrendCloses(), config: { risk: { maxOrderPct: 100, maxPositionPct: 20 } } })
    const { decision } = await run(b)
    expect(decision!.orderQuoteAmount).toBe('20')
    expect(decision!.riskReason).toContain('仓位上限')
  })

  it('空仓时不产生卖出信号；持仓时不加仓', async () => {
    const flat = setup({ closes: downtrendCloses() })
    expect(await run(flat)).toMatchObject({ outcome: 'hold', decision: null })

    const env = setup({ closes: uptrendCloses() })
    await run(env)
    setMarket(env, uptrendCloses(), minutesLater(60))
    env.setNow(minutesLater(60))
    expect((await run(env)).outcome).toBe('hold')
    expect(fills(env)).toHaveLength(1)
  })

  it('止损：跌破持仓均价 5% 立即卖出；之后锁定买入，直到短期均线回到长期均线下方', async () => {
    const env = setup({ closes: uptrendCloses() })
    await run(env)
    const entry = env.state().getPosition()!.cost.div(env.state().getLedger()!.base)
    // 同一根 K 线内价格大跌：只有止损会触发（均线还在上方）
    env.setNow(minutesLater(15))
    env.market.price = entry.mul('0.94').toDecimalPlaces(2)
    const stop = await run(env)
    expect(stop.outcome).toBe('filled')
    expect(stop.decision!.signalNote).toMatch(/^止损/)
    expect(env.state().getReentryLock()).not.toBeNull()

    // 均线仍在上方、RSI 正常：因为锁定，不买
    setMarket(env, uptrendCloses(), minutesLater(120))
    env.setNow(minutesLater(120))
    expect(await run(env)).toMatchObject({ outcome: 'hold', decision: null })
    expect(env.state().getReentryLock()).not.toBeNull()

    // 短期均线回到下方 → 解锁；再次站上去才买
    setMarket(env, downtrendCloses(), minutesLater(180))
    env.setNow(minutesLater(180))
    await run(env)
    expect(env.state().getReentryLock()).toBeNull()
    setMarket(env, uptrendCloses(), minutesLater(240))
    env.setNow(minutesLater(240))
    expect((await run(env)).outcome).toBe('filled')
  })

  it('移动止损：记录持仓以来最高价，回落超过设定比例时卖出', async () => {
    const env = setup({ closes: uptrendCloses(), config: { risk: { stopLossPct: 0, trailingStopPct: 2 } } })
    await run(env)
    env.setNow(minutesLater(15))
    env.market.price = new Decimal(56000)
    expect((await run(env)).outcome).toBe('hold')
    expect(env.state().getPosition()!.peak.toFixed()).toBe('56000')
    env.setNow(minutesLater(30))
    // 56000 × 98% = 54880
    env.market.price = new Decimal(54900)
    expect((await run(env)).outcome).toBe('hold')
    env.setNow(minutesLater(45))
    env.market.price = new Decimal(54800)
    const r = await run(env)
    expect(r.outcome).toBe('filled')
    expect(r.decision!.signalNote).toMatch(/^移动止损/)
  })

  it('当日亏损熔断：当天不再买入，止损照常卖出；下一个 UTC 日自动解除', async () => {
    const env = setup({ closes: uptrendCloses(), config: { risk: { maxOrderPct: 100, maxPositionPct: 100, dailyLossLimitPct: 5 } } })
    await run(env)
    const entry = env.state().getPosition()!.cost.div(env.state().getLedger()!.base)
    // 满仓时止损 5% 和熔断 5% 几乎同时触发：熔断只挡买入，止损照常卖出
    env.setNow(minutesLater(5))
    env.market.price = entry.mul('0.94').toDecimalPlaces(2)
    const stop = await run(env)
    expect(stop.outcome).toBe('filled')
    expect(stop.decision!.signalNote).toMatch(/^止损/)
    expect(env.state().getCircuit()).toMatchObject({ until: '2026-10-09T00:00:00.000Z' })
    expect(env.state().getCircuit()!.reason).toContain('今日已亏损')

    // 熔断期间的买入信号被风控拦下
    env.state().setReentryLock(null)
    setMarket(env, uptrendCloses(), minutesLater(65))
    env.setNow(minutesLater(65))
    const blocked = await run(env)
    expect(blocked.outcome).toBe('risk_block')
    expect(blocked.decision).toMatchObject({ riskRule: 'daily_loss' })

    const nextDay = new Date('2026-10-09T00:00:30Z')
    setMarket(env, flatCloses(), nextDay)
    env.setNow(nextDay)
    await run(env)
    expect(env.state().getCircuit()).toBeNull()
    expect(env.state().getDayStart()!.date).toBe('2026-10-09')
  })

  it('暂停：不交易、连止损也不执行，资产照常记录；恢复后继续', async () => {
    const env = setup({ closes: uptrendCloses() })
    env.engine.pause()
    const paused = await run(env)
    expect(paused).toMatchObject({ outcome: 'paused', decision: null })
    expect(env.store.latestEquity(env.season.id).get(env.agentId)!.total).toBe('100')
    env.engine.resume()
    env.setNow(minutesLater(15))
    expect((await run(env)).outcome).toBe('filled')

    env.engine.pause()
    env.setNow(minutesLater(30))
    env.market.price = env.market.price.mul('0.9')
    expect((await run(env)).outcome).toBe('paused')
    expect(fills(env)).toHaveLength(1)
  })
})

describe('一轮的流程', () => {
  it('行情取不到：记下原因、跳过这一轮，不写资产快照；下一轮照常', async () => {
    const env = setup()
    env.market.failOn.getKlines = new MarketError('行情接口 /api/v3/klines 失败（HTTP 500）：oops')
    const first = await run(env)
    expect(first.error).toContain('取行情失败，本轮跳过')
    expect(first.outcomes).toEqual([])
    expect(env.store.latestTick()).toMatchObject({ price: null, error: expect.stringContaining('HTTP 500') })
    expect(env.store.latestEquity(env.season.id).size).toBe(0)
    env.setNow(minutesLater(15))
    expect((await run(env)).outcome).toBe('hold')
  })

  it('同一时间只允许一轮运行', async () => {
    const env = setup()
    const [a, b] = await Promise.all([env.engine.runOnce('schedule'), env.engine.runOnce('manual')])
    expect(a.status).toBe('done')
    expect(b.status).toBe('busy')
    expect(env.engine.isRunning).toBe(false)
  })

  it('没有进行中的赛季时不运行', async () => {
    const env = setup()
    env.store.db.exec(`UPDATE seasons SET ended_at = '${NOW.toISOString()}'`)
    expect(await env.engine.runOnce('schedule')).toEqual({ status: 'done', tickId: null, error: '没有进行中的赛季', outcomes: [] })
  })
})

describe('多个模型', () => {
  const hold = '{"action":"hold","size_pct":0,"confidence":0.5,"reason":"等等"}'

  it('一轮只取一次行情，所有模型按同一个价格决策和成交，各自记账', async () => {
    const env = setup({ closes: uptrendCloses(), llm: [hold], baseline: true })
    const getPrice = vi.spyOn(env.market, 'getPrice')
    const r = await env.engine.runOnce('schedule')
    if (r.status !== 'done') throw new Error('busy')
    expect(getPrice).toHaveBeenCalledTimes(1)
    expect(Object.fromEntries(r.outcomes.map(o => [o.agentId, o.outcome]))).toEqual({ [env.llmAgentId!]: 'hold', [env.baselineId!]: 'filled' })
    const decisions = env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 10, offset: 0 }).items
    expect(new Set(decisions.map(d => `${d.tickId}@${d.price}`))).toEqual(new Set([`${r.tickId}@53000`]))
    const equity = env.store.latestEquity(env.season.id)
    expect(equity.get(env.llmAgentId!)!.total).toBe('100')
    expect(Number(equity.get(env.baselineId!)!.total)).toBeLessThan(100)
  })

  it('一个模型出错不影响其他模型', async () => {
    const env = setup({ closes: uptrendCloses(), baseline: true })
    // 一个没有 Provider 的 LLM 模型
    const broken = env.store.insertAgent({ kind: 'llm', name: '坏模型', color: '#dc2626', model: 'x' }, NOW)
    env.store.addEntry(env.season.id, broken, NOW)
    const r = await run(env, 'schedule', broken)
    expect(r.outcome).toBe('error')
    expect(r.decision!.error).toContain('没有可用的 Provider')
    expect(r.outcomes.find(o => o.agentId === env.baselineId)!.outcome).toBe('filled')
  })

  it('中途加入的模型从加入后的第一轮开始建账本；归档的模型不再参赛', async () => {
    const env = setup()
    await run(env)
    const late = env.store.insertAgent({ kind: 'baseline', name: '后来的', color: '#16a34a' }, minutesLater(10))
    env.store.addEntry(env.season.id, late, minutesLater(10))
    env.setNow(minutesLater(15))
    await run(env)
    expect(env.state(late).getInitial()!.at).toBe(minutesLater(15).toISOString())
    expect(env.state().getInitial()!.at).toBe(NOW.toISOString())

    env.store.setAgentStatus(late, 'archived', minutesLater(20))
    env.store.leaveEntry(env.season.id, late, minutesLater(20))
    env.setNow(minutesLater(30))
    const r = await env.engine.runOnce('schedule')
    if (r.status !== 'done') throw new Error('busy')
    expect(r.outcomes.map(o => o.agentId)).toEqual([env.agentId])
  })
})
