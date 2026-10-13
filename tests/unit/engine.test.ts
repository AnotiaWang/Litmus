/** 用模拟交易所和模拟 LLM 跑完整决策循环 */
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { ExchangeError, RateLimitError } from '../../server/lib/exchange'
import { accountView, decisionSummary } from '../../server/lib/views'
import { BASE_ENV, deathCrossCloses, goldenCrossCloses, makeKlines, NOW, setup, steadyRiseCloses } from './helpers'

const approve = (pct: number) => `{"decision":"approve","size_pct":${pct},"confidence":0.8,"reason":"同意"}`
const reject = '{"decision":"reject","size_pct":0,"confidence":0.3,"reason":"波动太大"}'

const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000)

/** 切换行情：K 线在 at 之前收盘，现价 = 最后一根收盘价 */
function setMarket(env: ReturnType<typeof setup>, closes: number[], at: Date) {
  env.exchange.klines = makeKlines(closes, at.getTime() - 1000)
  env.exchange.price = new Decimal(env.exchange.klines.at(-1)!.close)
}

async function run(env: ReturnType<typeof setup>) {
  const r = await env.engine.runOnce('schedule')
  if (r.status !== 'done') throw new Error('unexpected busy')
  return { ...r, decision: env.store.getDecision(r.decisionId)! }
}

describe('决策循环', () => {
  it('观望：记录指标和原因，初始化账本，写资产快照', async () => {
    const env = setup()
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('hold')
    expect(decision).toMatchObject({ signal: 'hold', trigger: 'schedule', price: '50020', llmDecision: null, orderId: null })
    expect(decision.indicators!.rsi).toBeTypeOf('number')
    expect(env.store.getLedger()!.usdt.toFixed()).toBe('100')
    expect(env.store.getInitial()).toMatchObject({ budget: '100', price: '50020' })
    expect(env.store.latestSnapshot()).toMatchObject({ total: '100', benchmark: '100' })
    expect(env.reviewer!.calls).toHaveLength(0)
    expect(env.exchange.orders).toHaveLength(0)
  })

  it('买入成交：用决策 ID 作为 clientOrderId，按实际成交（扣手续费）更新账本', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(40)] })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(env.exchange.orders).toHaveLength(1)
    const order = env.exchange.orders[0]!
    expect(order.side).toBe('BUY')
    expect(order.clientOrderId).toBe(decision.id)
    expect(decision).toMatchObject({ signal: 'buy', llmDecision: 'approve', llmSizePct: 40, riskPassed: true, orderSide: 'BUY', orderQuoteAmount: '40', orderStatus: 'FILLED' })
    // 40 USDT / 53000 → 0.00075 BTC（步长取整），手续费 0.1% 以 BTC 扣
    const ledger = env.store.getLedger()!
    expect(ledger.usdt.toFixed()).toBe(new Decimal(100).minus(decision.filledQuote!).toFixed())
    expect(ledger.base.toFixed()).toBe('0.00074925')
    expect(decision.commission).toBe('0.00000075 BTC')
    // LLM 收到了账本、限额和 24 根 K 线
    const call = env.reviewer!.calls[0]!
    expect(call.ledger).toEqual({ usdt: '100', base: '0', baseAsset: 'BTC' })
    expect(call.klines).toHaveLength(24)
  })

  it('卖出成交：不经过 LLM，全部卖出，USDT 扣除手续费后入账，清空持仓成本', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(40)] })
    await run(env)
    expect(env.store.getPosition()).not.toBeNull()
    const usdtAfterBuy = env.store.getLedger()!.usdt
    const later = minutesLater(61)
    env.setNow(later)
    setMarket(env, deathCrossCloses(), later)
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'sell', orderSide: 'SELL', orderQty: '0.00074', llmDecision: null })
    expect(env.reviewer!.calls).toHaveLength(1)
    expect(env.store.getPosition()).toBeNull()
    const ledger = env.store.getLedger()!
    // 0.00074 × 49000 = 36.26，扣 0.1% 手续费
    expect(ledger.usdt.toFixed()).toBe(usdtAfterBuy.plus('36.26').minus('0.03626').toFixed())
    expect(ledger.base.toFixed()).toBe('0.00000925')
  })

  it('同一根 K 线上的信号只处理一次，换了新 K 线再出现才会再处理', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [reject], settings: { cooldownMinutes: 0 } })
    expect((await run(env)).outcome).toBe('llm_reject')
    env.setNow(minutesLater(15))
    const again = await run(env)
    expect(again.outcome).toBe('hold')
    expect(again.decision.signalNote).toContain('已在之前的轮次处理过')
    expect(env.reviewer!.calls).toHaveLength(1)
    env.setNow(minutesLater(60))
    setMarket(env, goldenCrossCloses(), minutesLater(60))
    expect((await run(env)).outcome).toBe('llm_reject')
    expect(env.reviewer!.calls).toHaveLength(2)
  })

  it('出错的轮次不算处理过，下一轮同一根 K 线可以重试', async () => {
    const env = setup({ closes: goldenCrossCloses() })
    env.exchange.failOn.order = new ExchangeError('POST /api/v3/order 请求超时', undefined, undefined, true)
    expect((await run(env)).outcome).toBe('error')
    env.setNow(minutesLater(15))
    expect((await run(env)).outcome).toBe('filled')
  })

  it('低于最小下单额的零头不算持仓，不会因 RSI 过热反复产生卖出信号', async () => {
    const env = setup({ closes: steadyRiseCloses() })
    env.store.setInitial({ budget: '100', price: '50000', at: NOW.toISOString() })
    env.store.setLedger({ usdt: new Decimal(100), base: new Decimal('0.00000925') })
    expect((await run(env)).decision.signal).toBe('hold')
    env.store.setLedger({ usdt: new Decimal(50), base: new Decimal('0.001') })
    env.setNow(minutesLater(60))
    setMarket(env, steadyRiseCloses(), minutesLater(60))
    expect((await run(env)).decision.signal).toBe('sell')
  })

  it('LLM 否决：不下单', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [reject] })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('llm_reject')
    expect(decision).toMatchObject({ llmDecision: 'reject', llmReason: '波动太大', riskPassed: null })
    expect(env.exchange.orders).toHaveLength(0)
  })

  it('LLM 返回非法 JSON：重试后仍非法则按否决处理，记录原始返回', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: ['好的，我建议买入', '{"decision":"approve"}'] })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('llm_reject')
    expect(decision.llmRaw).toContain('好的，我建议买入')
    expect(decision.llmRaw).toContain('{"decision":"approve"}')
    expect(decision.error).toMatch(/LLM/)
    expect(env.exchange.orders).toHaveLength(0)
  })

  it('LLM 调用详情和提示词写进决策记录，列表接口不带', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: ['好的，我建议买入', reject] })
    const { decision } = await run(env)
    expect(decision.llmPrompt!.user).toContain('BTCUSDT')
    expect(decision.llmCalls).toHaveLength(2)
    expect(decision.llmCalls![0]!.error).toMatch(/输出不合格/)
    expect(decision.llmCalls![1]).toMatchObject({ httpStatus: 200, error: null })
    const summary = decisionSummary(env.store.getDecision(decision.id)!)
    expect(summary).not.toHaveProperty('llmCalls')
    expect(summary).not.toHaveProperty('llmPrompt')
  })

  it('LLM 关闭时规则信号直接进入风控，金额按单笔上限', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: null, settings: { llmEnabled: false } })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision.orderQuoteAmount).toBe('50')
  })

  it('配置了 LLM 但面板里关闭时不调用 LLM', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [reject], settings: { llmEnabled: false } })
    const { outcome, decision } = await run(env)
    expect(env.reviewer!.calls).toHaveLength(0)
    expect(outcome).toBe('filled')
    expect(decision.llmDecision).toBeNull()
  })

  it('面板里改了设置，下一轮按新设置运行', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: null, settings: { llmEnabled: false } })
    env.store.setSettings({ ...env.store.getSettings(), maxOrderUsdt: '30' })
    const { decision } = await run(env)
    expect(decision.orderQuoteAmount).toBe('30')
  })

  /** 买入 → 60 分钟后趋势转弱卖出 → 90 分钟时又出现买入信号 */
  async function buySellBuy(env: ReturnType<typeof setup>) {
    await run(env)
    env.setNow(minutesLater(60))
    setMarket(env, deathCrossCloses(), minutesLater(60))
    // 现价高于止损线，走“趋势转弱”卖出（止损卖出会锁定再次买入）
    env.exchange.price = new Decimal(52000)
    const sell = await run(env)
    expect(sell.decision.signalNote).toMatch(/^趋势转弱/)
    env.setNow(minutesLater(90))
    setMarket(env, goldenCrossCloses(), minutesLater(90))
    return { sell, buy: await run(env) }
  }

  it('风控拦截：交易冷却时间（卖出不受限；买入被预检拦下，不调用 LLM）', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(20)], settings: { cooldownMinutes: 120 } })
    const { sell, buy } = await buySellBuy(env)
    expect(sell.outcome).toBe('filled')
    expect(buy.outcome).toBe('risk_block')
    expect(buy.decision).toMatchObject({ riskPassed: false, riskRule: 'cooldown', llmDecision: null })
    expect(env.reviewer!.calls).toHaveLength(1)
    expect(env.exchange.orders).toHaveLength(2)
  })

  it('风控拦截：每日交易次数（卖出不受限）', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(20)], settings: { maxTradesPerDay: 1, cooldownMinutes: 0 } })
    const { sell, buy } = await buySellBuy(env)
    expect(sell.outcome).toBe('filled')
    expect(buy.decision.riskRule).toBe('max_trades')
    expect(env.reviewer!.calls).toHaveLength(1)
  })

  it('风控调整：仓位上限把买入金额调小', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(100)], settings: { maxOrderUsdt: '100', maxPositionPct: 10 } })
    const { decision } = await run(env)
    expect(decision.orderQuoteAmount).toBe('10')
    expect(decision.riskReason).toContain('仓位上限')
  })

  it('空仓时不产生卖出信号，也不调用 LLM', async () => {
    const env = setup({ closes: deathCrossCloses() })
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('hold')
    expect(decision.signal).toBe('hold')
    expect(env.reviewer!.calls).toHaveLength(0)
  })

  it('持仓时不加仓', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(20)] })
    await run(env)
    env.setNow(minutesLater(60))
    setMarket(env, goldenCrossCloses(), minutesLater(60))
    expect((await run(env)).decision.signal).toBe('hold')
    expect(env.exchange.orders).toHaveLength(1)
  })

  it('止损：跌破持仓均价 5% 立即卖出；之后锁定买入，直到短期均线回到长期均线下方', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(40)] })
    await run(env)
    const entry = env.store.getPosition()!.cost.div(env.store.getLedger()!.base)
    // 同一根 K 线内价格大跌：只有止损会触发（均线还在上方）
    env.setNow(minutesLater(15))
    env.exchange.price = entry.mul('0.94').toDecimalPlaces(2)
    const stop = await run(env)
    expect(stop.outcome).toBe('filled')
    expect(stop.decision.signalNote).toMatch(/^止损/)
    expect(env.store.getReentryLock()).not.toBeNull()

    // 均线仍在上方、RSI 正常：因为锁定，不买
    env.setNow(minutesLater(120))
    setMarket(env, goldenCrossCloses(), minutesLater(120))
    const locked = await run(env)
    expect(locked.decision.signal).toBe('hold')
    expect(locked.decision.signalNote).toContain('卖出后等待趋势重新确认')

    // 短期均线回到下方 → 解锁；再次站上去才买
    env.setNow(minutesLater(180))
    setMarket(env, deathCrossCloses(), minutesLater(180))
    await run(env)
    expect(env.store.getReentryLock()).toBeNull()
    env.setNow(minutesLater(240))
    setMarket(env, goldenCrossCloses(), minutesLater(240))
    expect((await run(env)).outcome).toBe('filled')
  })

  it('移动止损：记录持仓以来最高价，回落超过设定比例时卖出', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(40)], settings: { stopLossPct: 0, trailingStopPct: 2 } })
    await run(env)
    env.setNow(minutesLater(15))
    env.exchange.price = new Decimal(56000)
    expect((await run(env)).outcome).toBe('hold')
    expect(env.store.getPosition()!.peak.toFixed()).toBe('56000')
    env.setNow(minutesLater(30))
    // 56000 × 98% = 54880
    env.exchange.price = new Decimal(54900)
    expect((await run(env)).outcome).toBe('hold')
    env.setNow(minutesLater(45))
    env.exchange.price = new Decimal(54800)
    const r = await run(env)
    expect(r.outcome).toBe('filled')
    expect(r.decision.signalNote).toMatch(/^移动止损/)
  })

  it('持仓没有成本记录时（如旧版本数据）按当前价补记', async () => {
    const env = setup()
    env.store.setInitial({ budget: '100', price: '50000', at: NOW.toISOString() })
    env.store.setLedger({ usdt: new Decimal(50), base: new Decimal('0.001') })
    await run(env)
    expect(env.store.getPosition()).toMatchObject({ cost: new Decimal('50.02'), peak: new Decimal('50020') })
  })

  it('交易所报错：本轮记录错误，不影响下一轮', async () => {
    const env = setup()
    env.exchange.failOn.getKlines = new ExchangeError('GET /api/v3/klines 失败（HTTP 500）', 500)
    const first = await run(env)
    expect(first.outcome).toBe('error')
    expect(first.decision.error).toContain('HTTP 500')
    env.setNow(minutesLater(15))
    expect((await run(env)).outcome).toBe('hold')
  })

  it('下单时限流：记录错误，账本不变', async () => {
    const env = setup({ closes: goldenCrossCloses() })
    env.exchange.failOn.order = new RateLimitError('交易所限流（HTTP 429）', 429)
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('error')
    expect(decision.error).toContain('429')
    expect(env.store.getLedger()!.usdt.toFixed()).toBe('100')
  })

  it('暂停时只记录信号，不调用 LLM、不下单；恢复后继续', async () => {
    const env = setup({ closes: goldenCrossCloses() })
    env.engine.pause()
    const paused = await run(env)
    expect(paused.outcome).toBe('paused')
    expect(paused.decision.signal).toBe('buy')
    expect(env.reviewer!.calls).toHaveLength(0)
    expect(env.exchange.orders).toHaveLength(0)
    env.engine.resume()
    env.setNow(minutesLater(15))
    expect((await run(env)).outcome).toBe('filled')
  })

  it('同一时间只允许一轮运行', async () => {
    const env = setup()
    const [a, b] = await Promise.all([env.engine.runOnce('schedule'), env.engine.runOnce('manual')])
    expect(a.status).toBe('done')
    expect(b.status).toBe('busy')
    expect(env.store.listDecisions({ limit: 10, offset: 0, onlyActions: false }).total).toBe(1)
    expect(env.engine.isRunning).toBe(false)
  })

  it('当日亏损熔断：自动暂停到下一个 UTC 日，之后自动恢复', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(100)], settings: { dailyLossLimitPct: 0.1 } })
    await run(env)
    // 价格下跌 2%：持仓 50 USDT 亏 1 USDT，账本亏损约 1%
    const t1 = minutesLater(15)
    env.setNow(t1)
    env.exchange.price = env.exchange.price.mul('0.98')
    const r = await run(env)
    expect(r.outcome).toBe('paused')
    const pause = env.store.getPause()
    expect(pause).toMatchObject({ paused: true, source: 'daily_loss', until: '2026-10-09T00:00:00.000Z' })
    expect(pause.reason).toContain('熔断')

    env.setNow(new Date('2026-10-09T00:00:30Z'))
    setMarket(env, deathCrossCloses().map(() => 50000), new Date('2026-10-09T00:00:30Z'))
    await run(env)
    expect(env.store.getPause().paused).toBe(false)
    expect(env.store.getDayStart()!.date).toBe('2026-10-09')
  })

  it('当日亏损熔断期间照常卖出：止损不会被熔断挡住，但仍然不买', async () => {
    // 满仓时止损 5% 和熔断 5% 几乎同时触发，熔断先生效；以前这会让止损一直卖不出去
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(100)], settings: { maxPositionPct: 100, maxOrderUsdt: '100', dailyLossLimitPct: 5 } })
    await run(env)
    const entry = env.store.getPosition()!.cost.div(env.store.getLedger()!.base)
    env.setNow(minutesLater(5))
    env.exchange.price = entry.mul('0.94').toDecimalPlaces(2)
    const stop = await run(env)
    expect(env.store.getPause()).toMatchObject({ paused: true, source: 'daily_loss' })
    expect(stop.outcome).toBe('filled')
    expect(stop.decision.signalNote).toMatch(/^止损/)
    expect(env.exchange.orders.at(-1)!.side).toBe('SELL')
    expect(env.store.getPosition()).toBeNull()

    // 熔断期间买入信号照样不执行
    env.store.setReentryLock(null)
    env.setNow(minutesLater(65))
    setMarket(env, goldenCrossCloses(), minutesLater(65))
    const buy = await run(env)
    expect(buy.decision.signal).toBe('buy')
    expect(buy.outcome).toBe('paused')
    expect(env.exchange.orders).toHaveLength(2)
  })

  it('手动暂停时连卖出也不执行', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(40)] })
    await run(env)
    env.engine.pause()
    env.setNow(minutesLater(15))
    env.exchange.price = env.exchange.price.mul('0.9')
    const r = await run(env)
    expect(r.decision.signal).toBe('sell')
    expect(r.outcome).toBe('paused')
    expect(env.exchange.orders).toHaveLength(1)
  })

  it('止盈卖出后锁定买入，不会马上追高买回', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [approve(40), approve(40)] })
    await run(env)
    // 一路上涨、RSI 过热：止盈卖出（价格远高于止损线）
    const hot = steadyRiseCloses().map(c => c + 15000)
    env.setNow(minutesLater(120))
    setMarket(env, hot, minutesLater(120))
    const tp = await run(env)
    expect(tp.outcome).toBe('filled')
    expect(tp.decision.signalNote).toContain('止盈')
    expect(env.store.getReentryLock()).not.toBeNull()

    // RSI 回落、均线仍在上方：锁定中，不买
    const cooled = [...hot.slice(0, 90), ...Array.from({ length: 10 }, (_, i) => hot[89]! - 100 - i * 60)]
    env.setNow(minutesLater(240))
    setMarket(env, cooled, minutesLater(240))
    const locked = await run(env)
    expect(locked.decision.signal).toBe('hold')
    expect(locked.decision.signalNote).toContain('卖出后等待趋势重新确认')
    expect(env.exchange.orders).toHaveLength(2)
  })

  it('账本超过账户真实余额：暂停并报错', async () => {
    const env = setup()
    env.exchange.balances.USDT!.free = new Decimal(10)
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('error')
    expect(decision.error).toContain('账本超过账户真实可用余额')
    expect(env.store.getPause()).toMatchObject({ paused: true, source: 'reconcile' })
  })

  it('基准 = 初始预算 × 当前价 ÷ 初始价', async () => {
    const env = setup()
    await run(env)
    env.setNow(minutesLater(15))
    env.exchange.price = new Decimal('60024')
    await run(env)
    // 100 × 60024 / 50020 = 120
    expect(env.store.latestSnapshot()!.benchmark).toBe('120')
  })

  it('决策记录里不包含任何 Key 或口令', async () => {
    const env = setup({ closes: goldenCrossCloses(), llm: [new Error(`boom ${BASE_ENV.LLM_API_KEY}`)] })
    await run(env)
    const dump = JSON.stringify(env.store.listDecisions({ limit: 100, offset: 0, onlyActions: false }))
      + JSON.stringify(env.store.db.prepare('SELECT * FROM state').all())
    for (const secret of [BASE_ENV.BINANCE_API_KEY, BASE_ENV.BINANCE_API_SECRET, BASE_ENV.ADMIN_TOKEN]) {
      expect(dump).not.toContain(secret)
    }
  })
})

describe('账户接口', () => {
  it('持仓均价和止损价保留完整精度（低价币不会被截成两位小数）', async () => {
    const env = setup({ env: { SYMBOL: 'DOGEUSDT' } })
    env.store.setInitial({ budget: '100', price: '0.12345', at: NOW.toISOString() })
    env.store.setLedger({ usdt: new Decimal(50), base: new Decimal(400) })
    env.store.setPosition({ cost: new Decimal('49.38'), peak: new Decimal('0.1250') })
    env.store.insertSnapshot({ createdAt: NOW.toISOString(), decisionId: null, price: '0.1240', usdt: '50', base: '400', total: '99.6', benchmark: '100.4' })
    const view = accountView(env)
    if (!view.ready) throw new Error('unexpected')
    // 49.38 / 400 = 0.12345；止损 0.12345 × 95% = 0.1172775
    expect(view).toMatchObject({ entryPrice: '0.12345', stopPrice: '0.1172775' })
  })

  it('空仓时没有均价和止损价', async () => {
    const env = setup()
    await run(env)
    const view = accountView(env)
    if (!view.ready) throw new Error('unexpected')
    expect(view).toMatchObject({ entryPrice: null, stopPrice: null })
  })
})

describe('存储', () => {
  it('启动时把未跑完的记录标记为中断', () => {
    const env = setup()
    env.store.insertDecision({ id: 'x', createdAt: NOW.toISOString(), trigger: 'manual', symbol: 'BTCUSDT', outcome: 'running' })
    expect(env.store.markInterrupted()).toBe(1)
    expect(env.store.getDecision('x')).toMatchObject({ outcome: 'interrupted' })
  })

  it('只看买卖信号', async () => {
    const env = setup()
    await run(env)
    env.setNow(minutesLater(15))
    setMarket(env, goldenCrossCloses(), minutesLater(15))
    await run(env)
    expect(env.store.listDecisions({ limit: 10, offset: 0, onlyActions: false }).total).toBe(2)
    const actions = env.store.listDecisions({ limit: 10, offset: 0, onlyActions: true })
    expect(actions.total).toBe(1)
    expect(actions.items[0]!.signal).toBe('buy')
  })
})
