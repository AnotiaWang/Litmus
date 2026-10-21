/** LLM 模型：用模拟行情和模拟 LLM 跑完整的一轮 */
import Decimal from 'decimal.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSecrets } from '../../server/lib/logger'
import { flatCloses, makeKlines, minutesLater, NOW, PROVIDER_KEY, run, setup, type ConfigOverrides, type Env } from './helpers'

const act = (action: 'buy' | 'sell' | 'hold', pct = 0) => `{"action":"${action}","size_pct":${pct},"confidence":0.7,"reason":"测试${action}"}`

function llmSetup(llm: Array<string | Error>, config: ConfigOverrides = {}) {
  return setup({ llm, config: { ...config, risk: { cooldownMinutes: 0, ...config.risk } } })
}

/** 时间推进到 at，K 线换成在 at 之前收盘的一组（现价不变） */
function advance(env: Env, at: Date) {
  env.setNow(at)
  env.market.klines = makeKlines(flatCloses(), at.getTime() - 1000)
}

afterEach(() => setSecrets([]))

describe('LLM 模型', () => {
  it('LLM 决定买入：按它给的比例成交；提示词里有账本、K 线和能否买卖；记下耗时和 token 用量', async () => {
    const env = llmSetup([act('buy', 40)])
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({
      signal: 'buy',
      signalNote: null,
      indicators: null,
      llmStatus: 'ok',
      llmDecision: 'buy',
      llmSizePct: 40,
      orderQuoteAmount: '40',
      llmPromptTokens: 100,
      llmCompletionTokens: 20
    })
    expect(decision!.llmDurationMs).toBeGreaterThanOrEqual(0)
    const input = env.llm!.calls[0]!
    expect(input.klines).toHaveLength(48)
    expect(input).toMatchObject({ position: null, blocked: { buy: null, sell: '空仓，没有可卖的币' }, cadence: '每根 1h K 线收盘后', limits: { maxBuyUsdt: '50.00', maxOrderPct: 50 } })
    expect(decision!.llmPrompt!.user).toContain('可用 100.00 USDT')
    expect(decision!.llmPrompt!.user).toContain('不可卖（空仓，没有可卖的币）')
  })

  it('日线：发给 LLM 的 K 线覆盖不到 14 天时附上最近 14 根已收盘日线；覆盖得到、或没有 LLM 模型参赛时不取', async () => {
    const day = 86_400_000
    const today = Date.UTC(2026, 9, 8)
    // 最后一根是今天、还没收盘
    const daily = Array.from({ length: 21 }, (_, i) => ({ ...makeKlines([50000], today)[0]!, openTime: today - (20 - i) * day, closeTime: today - (19 - i) * day - 1 }))

    const env = llmSetup([act('hold')])
    env.market.intervalKlines['1d'] = daily
    await run(env)
    const input = env.llm!.calls[0]!
    expect(input.dailyKlines).toHaveLength(14)
    expect(input.dailyKlines.at(-1)!.openTime).toBe(today - day)
    expect(env.store.getDecision('d-1')!.llmPrompt!.user).toContain('最近 14 根日线')

    // 48 根 8h K 线覆盖 16 天
    const long = llmSetup([act('hold')], { klineInterval: '8h' })
    await run(long)
    expect(long.llm!.calls[0]!.dailyKlines).toEqual([])

    const baseline = setup()
    const getKlines = vi.spyOn(baseline.market, 'getKlines')
    await run(baseline)
    expect(getKlines.mock.calls.map(c => c[1])).toEqual(['1h'])
  })

  it('日线取不到：这一轮提示词不带日线，照常询问 LLM 和运行基线', async () => {
    const env = setup({ llm: [act('hold')], baseline: true })
    vi.spyOn(env.market, 'getKlines').mockImplementation(async (_s, interval, limit) => {
      if (interval === '1d') throw new Error('1d 接口挂了')
      return env.market.klines.slice(-limit)
    })
    const r = await run(env)
    expect(r).toMatchObject({ error: null, outcome: 'hold' })
    expect(r.outcomes).toHaveLength(2)
    expect(env.llm!.calls[0]!.dailyKlines).toEqual([])
  })

  it('重试和超时统计：去掉 response_format 后重发不算重试；超时按固定文本识别', async () => {
    const env = llmSetup([new DOMException('timeout', 'TimeoutError') as unknown as Error, act('hold')])
    const { decision } = await run(env)
    expect(decision).toMatchObject({ llmStatus: 'ok', llmRetries: 1, llmTimeouts: 1, llmHttp429: 0 })
  })

  it('观望：记录这次询问，不交易', async () => {
    const env = llmSetup([act('hold', 30)])
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('hold')
    expect(decision).toMatchObject({ signal: 'hold', llmDecision: 'hold', llmSizePct: 0, orderSide: null })
  })

  it('每根 K 线只问一次：同一根 K 线的后续轮次只检查止损、不写记录，新 K 线收盘后再问；手动运行不受限制', async () => {
    const env = llmSetup([act('hold')])
    await run(env)
    env.setNow(minutesLater(15))
    expect(await run(env)).toMatchObject({ outcome: 'hold', decision: null })
    expect(env.llm!.calls).toHaveLength(1)

    expect((await run(env, 'manual')).decision).not.toBeNull()
    expect(env.llm!.calls).toHaveLength(2)

    advance(env, minutesLater(60))
    await run(env)
    expect(env.llm!.calls).toHaveLength(3)
  })

  it('LLM 输出不合格：程序代为观望，记为“输出不合格”，这根 K 线不算问过，下一轮重试', async () => {
    const env = llmSetup(['不是 JSON', '{"action":"buy","size_pct":0,"confidence":0.5,"reason":"x"}', act('hold')])
    const first = await run(env)
    expect(first.outcome).toBe('hold')
    expect(first.decision).toMatchObject({ signal: 'hold', llmStatus: 'invalid_output', llmDecision: 'hold', llmReason: '程序代为观望：LLM 未返回合法结果' })
    expect(first.decision!.signalNote).toContain('都会重试')
    expect(first.decision!.error).toMatch(/size_pct/)
    env.setNow(minutesLater(15))
    const retry = await run(env)
    expect(retry.decision).toMatchObject({ llmStatus: 'ok', llmDecision: 'hold', signalNote: null })
    expect(env.llm!.calls).toHaveLength(2)
  })

  it('请求失败（网络、超时、HTTP 错误）记为“请求失败”，和输出不合格分开统计', async () => {
    const env = llmSetup([new TypeError('fetch failed')])
    const { decision } = await run(env)
    expect(decision).toMatchObject({ llmStatus: 'request_failed', llmDecision: 'hold' })
    expect(decision!.llmCalls).toHaveLength(2)

    // 服务恢复后下一轮重问；平均耗时不算请求失败的那次（超时会把平均值拉得很高）
    env.llm!.responses = ['{"action":"hold","size_pct":0,"confidence":0.5,"reason":"等等"}']
    env.setNow(minutesLater(15))
    const retry = await run(env)
    expect(retry.decision).toMatchObject({ llmStatus: 'ok' })
    env.store.db.prepare('UPDATE decisions SET llm_duration_ms = ? WHERE id = ?').run(120_000, decision!.id)
    env.store.db.prepare('UPDATE decisions SET llm_duration_ms = ? WHERE id = ?').run(1_000, retry.decision!.id)
    expect(env.store.entryStats(env.season.id).get(env.agentId)).toMatchObject({ llmAsked: 2, llmOk: 1, llmFailed: 1, llmInvalid: 0, llmAvgDurationMs: 1_000 })
  })

  it('部分卖出：按比例卖出持币，持仓成本按比例减少；之前的决策和成交会发给 LLM', async () => {
    const env = llmSetup([act('buy', 50), act('sell', 50)])
    await run(env)
    const before = { base: env.state().getLedger()!.base, cost: env.state().getPosition()!.cost }
    advance(env, minutesLater(60))
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'sell', orderSide: 'sell', llmSizePct: 50 })
    const input = env.llm!.calls[1]!
    expect(input.position).not.toBeNull()
    // 买入 50 USDT 后已到 50% 的仓位上限
    expect(input.blocked).toMatchObject({ buy: expect.stringContaining('仓位上限'), sell: null })
    expect(input.recentDecisions).toMatchObject([{ action: 'buy', sizePct: 50, outcome: 'filled' }])
    expect(input.recentFills).toMatchObject([{ side: 'buy' }])
    expect(input.stats.hours).toBeGreaterThan(0)
    const after = { base: env.state().getLedger()!.base, cost: env.state().getPosition()!.cost }
    expect(after.base.lt(before.base)).toBe(true)
    expect(after.cost.toFixed()).toBe(before.cost.mul(after.base).div(before.base).toFixed())
  })

  it('止损由程序每轮检查：跌破止损线直接全部卖出，不问 LLM', async () => {
    const env = llmSetup([act('buy', 40)])
    await run(env)
    const entry = env.state().getPosition()!.cost.div(env.state().getLedger()!.base)
    env.setNow(minutesLater(15))
    env.market.price = entry.mul('0.94').toDecimalPlaces(2)
    const { outcome, decision } = await run(env)
    expect(outcome).toBe('filled')
    expect(decision).toMatchObject({ signal: 'sell', llmStatus: null, llmDecision: null, orderSide: 'sell' })
    expect(decision!.signalNote).toMatch(/^止损/)
    expect(Number(decision!.realizedPnl)).toBeLessThan(0)
    expect(env.llm!.calls).toHaveLength(1)
    expect(env.state().getPosition()).toBeNull()
  })

  it('既不能买入也没有持仓可卖时不问 LLM，不写记录，也不算问过', async () => {
    const env = llmSetup([act('hold')], { initialCapital: '3' })
    expect(await run(env)).toMatchObject({ outcome: 'hold', decision: null })
    expect(env.llm!.calls).toHaveLength(0)
    expect(env.state().getLlmSlot()).toBeNull()
  })

  it('持仓时不能买入（冷却中）：照常询问，并告诉 LLM 不能买入的原因', async () => {
    const env = llmSetup([act('buy', 40), act('hold')], { risk: { cooldownMinutes: 120 } })
    await run(env)
    advance(env, minutesLater(60))
    await run(env)
    expect(env.llm!.calls[1]!.blocked.buy).toContain('交易冷却时间')
  })

  it('暂停时不问 LLM、不交易', async () => {
    const env = llmSetup([act('buy', 40)])
    env.engine.pause()
    expect(await run(env)).toMatchObject({ outcome: 'paused', decision: null })
    expect(env.llm!.calls).toHaveLength(0)
  })

  it('单个模型暂停：不问 LLM、不交易、止损也不执行，资产按当前价照常记录，排行榜跟着行情变；恢复后继续', async () => {
    const env = llmSetup([act('buy', 40), act('hold')])
    expect((await run(env)).outcome).toBe('filled')
    env.store.setAgentStatus(env.llmAgentId!, 'paused', NOW)

    // 跌破止损线：暂停中不卖，但资产快照按新价格记
    advance(env, minutesLater(60))
    env.market.price = env.market.price.mul('0.9')
    const paused = await run(env)
    expect(paused).toMatchObject({ outcome: 'paused', decision: null })
    expect(env.llm!.calls).toHaveLength(1)
    const ledger = env.state().getLedger()!
    expect(env.store.latestEquity(env.season.id).get(env.agentId)).toMatchObject({
      price: env.market.price.toFixed(),
      total: ledger.usdt.plus(ledger.base.mul(env.market.price)).toFixed()
    })

    env.store.setAgentStatus(env.llmAgentId!, 'active', NOW)
    advance(env, minutesLater(120))
    env.market.price = env.market.price.mul('0.9')
    expect((await run(env)).outcome).toBe('filled')
  })

  it('只看买卖：观望的询问记录不在其中', async () => {
    const env = llmSetup([act('hold'), act('buy', 40)])
    await run(env)
    advance(env, minutesLater(60))
    await run(env)
    const all = env.store.listDecisions({ seasonId: env.season.id, onlyActions: false, limit: 10, offset: 0 })
    const actions = env.store.listDecisions({ seasonId: env.season.id, onlyActions: true, limit: 10, offset: 0 })
    expect(all.total).toBe(2)
    expect(actions.items.map(d => d.signal)).toEqual(['buy'])
    // 按模型筛选
    expect(env.store.listDecisions({ seasonId: env.season.id, agentId: env.agentId + 100, onlyActions: false, limit: 10, offset: 0 }).total).toBe(0)
  })

  it('决策记录和运行状态里不包含 Provider 的 Key', async () => {
    setSecrets([PROVIDER_KEY])
    const env = llmSetup([new Error(`boom ${PROVIDER_KEY}`)])
    const { decision } = await run(env)
    expect(decision!.error).toContain('boom ***')
    const dump = JSON.stringify(env.store.db.prepare('SELECT * FROM decisions').all())
      + JSON.stringify(env.store.db.prepare('SELECT * FROM entry_state').all())
    expect(dump).not.toContain(PROVIDER_KEY)
  })

  it('按本轮行情快照的价格成交，和 LLM 回复的快慢无关', async () => {
    const env = llmSetup([act('buy', 40)])
    const price = env.market.price
    const { decision } = await run(env)
    expect(decision!.price).toBe(price.toFixed())
    expect(new Decimal(decision!.filledQuote!).div(decision!.filledQty!).toFixed()).toBe(price.toFixed())
    expect(decision!.createdAt).toBe(NOW.toISOString())
  })
})
