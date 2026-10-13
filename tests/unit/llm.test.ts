import { describe, expect, it } from 'vitest'
import { buildDecidePrompt, buildUserPrompt, DECIDE_SYSTEM_PROMPT, MAX_SAVED_CHARS, MockLlm, OpenAiLlm, parseDecision, parseReview, splitThink, SYSTEM_PROMPT, type DecideInput, type ReviewInput } from '../../server/lib/llm'
import { marketStats } from '../../server/lib/strategy'
import { makeKlines } from './helpers'

const klines = makeKlines(Array.from({ length: 24 }, (_, i) => 59000 + i * 10), Date.UTC(2026, 9, 8))

const input: ReviewInput = {
  symbol: 'BTCUSDT',
  signalNote: '金叉',
  now: '2026-10-08T00:00:01.234Z',
  price: '60000',
  klineInterval: '1h',
  klines,
  indicators: { close: 60000, smaFast: 59000, smaSlow: 58900, prevSmaFast: 58800, prevSmaSlow: 58850, rsi: 55 },
  periods: { smaFast: 20, smaSlow: 50, rsiPeriod: 14 },
  stats: marketStats(klines),
  ledger: { usdt: '100', base: '0', baseAsset: 'BTC' },
  stopRules: { stopLossPct: 5, trailingStopPct: 0 },
  limits: { maxOrderUsdt: '50', minOrderUsdt: '5', maxPositionPct: 50 },
  recentDecisions: []
}

const ok = '{"decision":"approve","size_pct":40,"confidence":0.7,"reason":"趋势转强"}'

describe('解析 LLM 返回', () => {
  it('合法 JSON', () => {
    expect(parseReview(ok)).toEqual({ decision: 'approve', sizePct: 40, confidence: 0.7, reason: '趋势转强' })
  })

  it('容忍 ```json 代码块', () => {
    expect(parseReview(`\`\`\`json\n${ok}\n\`\`\``).sizePct).toBe(40)
  })

  it.each([
    ['非 JSON', '我觉得可以买'],
    ['size_pct 越界', '{"decision":"approve","size_pct":150,"confidence":0.7,"reason":"x"}'],
    ['confidence 越界', '{"decision":"approve","size_pct":10,"confidence":2,"reason":"x"}'],
    ['decision 非法', '{"decision":"buy","size_pct":10,"confidence":0.5,"reason":"x"}'],
    ['缺少 reason', '{"decision":"approve","size_pct":10,"confidence":0.5}']
  ])('%s 时报错', (_name, text) => {
    expect(() => parseReview(text)).toThrow()
  })
})

const decideInput: DecideInput = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  klineInterval: '4h',
  cadence: '每根 4h K 线收盘后',
  now: '2026-10-08T12:00:00.000Z',
  price: '60000',
  klines,
  indicators: input.indicators,
  periods: input.periods,
  stats: input.stats,
  ledger: { usdt: '40', base: '0.001', positionValue: '60.00', equity: '100.00' },
  position: { entryPrice: '58000', pnlPct: '3.45', peakPrice: '61000', stopPrice: '55100' },
  stopRules: { stopLossPct: 5, trailingStopPct: 0 },
  limits: { maxOrderUsdt: '50', minOrderUsdt: '5', maxPositionPct: 80 },
  blocked: { buy: '交易冷却时间：距上一笔成交仅 10 分钟，需间隔 60 分钟', sell: null },
  recentDecisions: [{ time: '2026-10-08T08:00:00.000Z', price: '58000', action: 'buy', sizePct: 60, outcome: 'filled', reason: '趋势向上' }],
  recentFills: [{ time: '2026-10-08T08:00:00.000Z', side: 'buy', price: '58000', qty: '0.001', quote: '58' }]
}

describe('解析 LLM 决策', () => {
  it('合法 JSON；观望时比例记为 0', () => {
    expect(parseDecision('{"action":"sell","size_pct":50,"confidence":0.6,"reason":"转弱"}')).toEqual({ action: 'sell', sizePct: 50, confidence: 0.6, reason: '转弱' })
    expect(parseDecision('```json\n{"action":"hold","size_pct":30,"confidence":0.6,"reason":"等等"}\n```').sizePct).toBe(0)
  })

  it.each([
    ['action 非法', '{"action":"approve","size_pct":10,"confidence":0.5,"reason":"x"}'],
    ['买入比例为 0', '{"action":"buy","size_pct":0,"confidence":0.5,"reason":"x"}'],
    ['size_pct 越界', '{"action":"sell","size_pct":120,"confidence":0.5,"reason":"x"}'],
    ['缺少 reason', '{"action":"hold","size_pct":0,"confidence":0.5}']
  ])('%s 时报错', (_name, text) => {
    expect(() => parseDecision(text)).toThrow()
  })
})

describe('LLM 决策', () => {
  it('提示词包含询问频率、账本、持仓、止损、能否买卖、指标、K 线和最近的决策', () => {
    const prompt = buildDecidePrompt(decideInput)
    for (const s of [
      '每根 4h K 线收盘后询问你一次',
      '可用 40 USDT，持有 0.001 BTC（市值 60.00 USDT），总资产 100.00 USDT',
      '持仓均价 58000（含手续费），浮动盈亏 3.45%',
      '当前止损线 55100',
      '跌破持仓均价 5% 止损，移动止损关闭',
      '现在能否买入：不可以（交易冷却时间',
      '现在能否卖出：可以',
      '最小下单额 5 USDT',
      'SMA20 59000（上一根 58800），SMA50 58900（上一根 58850），RSI14 55.0',
      '最近 24 根 4h K 线',
      '量1',
      '2026-10-08 08:00 价格58000 买入 60% 结果已成交 理由：趋势向上',
      '买入 0.001 BTC，金额 58 USDT'
    ]) {
      expect(prompt).toContain(s)
    }
  })

  it('两次都不合格时按观望处理', async () => {
    const r = await new MockLlm(['我建议买入']).decide(decideInput)
    expect(r).toMatchObject({ action: 'hold', sizePct: 0, valid: false })
    expect(r.calls).toHaveLength(2)
    expect(r.prompt.user).toContain('BTCUSDT')
  })
})

describe('LLM 复核', () => {
  it('提示词包含时间、指标、行情摘要、账本、止损、限额和 K 线', () => {
    const prompt = buildUserPrompt(input)
    for (const s of [
      'BTCUSDT',
      '当前时间（UTC）：2026-10-08 00:00',
      '信号原因：金叉',
      'SMA20 59000（上一根 58800），SMA50 58900（上一根 58850），RSI14 55.0',
      '最近 24 小时：涨跌 0.39%，最高 59822.3，最低 58410',
      'ATR14',
      '最新一根成交量是之前 20 根平均的 1.00 倍',
      '可用 100 USDT',
      '止损规则：跌破持仓均价 5% 止损，移动止损关闭',
      '单笔最多 50 USDT，不能低于交易所最小下单额 5 USDT',
      '50%',
      '最近 24 根 1h K 线',
      '2026-10-07 23:00 开59230 高59822.3 低58637.7 收59230 量1'
    ]) {
      expect(prompt).toContain(s)
    }
    expect(prompt.match(/SMA20/g)).toHaveLength(1)
  })

  it('交易所返回值的尾零去掉，数据不足的指标注明', () => {
    const k = { ...klines.at(-1)!, open: '83102.00000000', high: '83173.29000000', low: '83099.34000000', close: '83129.92000000', volume: '186.14116000' }
    const prompt = buildUserPrompt({ ...input, klines: [k], indicators: { ...input.indicators, smaSlow: Number.NaN } })
    expect(prompt).toContain('开83102 高83173.29 低83099.34 收83129.92 量186.141')
    expect(prompt).toContain('SMA50 数据不足')
  })

  it('输出格式先写理由再给结论', () => {
    expect(SYSTEM_PROMPT.indexOf('"reason"')).toBeLessThan(SYSTEM_PROMPT.indexOf('"decision"'))
    expect(DECIDE_SYSTEM_PROMPT.indexOf('"reason"')).toBeLessThan(DECIDE_SYSTEM_PROMPT.indexOf('"action"'))
  })

  it('最近的决策记录按时间先后列出，代码翻译成中文并带上 LLM 理由', () => {
    const prompt = buildUserPrompt({
      ...input,
      recentDecisions: [
        { time: '2026-10-08T08:00:00.000Z', price: '58000', signal: 'buy', llmDecision: 'reject', outcome: 'llm_reject', reason: 'RSI 过高' },
        { time: '2026-10-08T09:00:00.000Z', price: '59000', signal: 'hold', llmDecision: null, outcome: 'hold', reason: null }
      ]
    })
    expect(prompt).toContain('2026-10-08 08:00 价格58000 信号买入 LLM否决 结果LLM 否决 理由：RSI 过高\n2026-10-08 09:00 价格59000 信号观望 LLM- 结果观望')
  })

  it('第一次非法、第二次合法：采用第二次结果，原始返回都保留', async () => {
    const r = await new MockLlm(['不是 JSON', ok]).review(input)
    expect(r).toMatchObject({ decision: 'approve', sizePct: 40, valid: true })
    expect(r.raw).toContain('不是 JSON')
    expect(r.raw).toContain('趋势转强')
  })

  it('两次都非法时按否决处理，并记录原始返回', async () => {
    const r = await new MockLlm(['{"decision":"approve","size_pct":101,"confidence":1,"reason":"x"}']).review(input)
    expect(r).toMatchObject({ decision: 'reject', sizePct: 0, valid: false })
    expect(r.raw).toContain('101')
    expect(r.error).toMatch(/size_pct/)
  })

  it('网络错误两次时按否决处理', async () => {
    const r = await new MockLlm([new TypeError('fetch failed')]).review(input)
    expect(r).toMatchObject({ decision: 'reject', valid: false, raw: null })
    expect(r.error).toMatch(/网络错误/)
  })

  it('请求格式：温度 0.2、json_object；服务端不支持 response_format 时自动去掉', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      expect(url).toBe('http://llm.local/v1/chat/completions')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
      const body = JSON.parse(init.body as string)
      bodies.push(body)
      if (body.response_format) return new Response('{"error":"response_format is not supported"}', { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { content: ok } }] }))
    }) as unknown as typeof fetch
    const reviewer = new OpenAiLlm({ baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm', fetch: fetchFn })
    const r = await reviewer.review(input)
    expect(r.valid).toBe(true)
    expect(bodies[0]).toMatchObject({ model: 'm', temperature: 0.2, response_format: { type: 'json_object' } })
    expect(bodies[1]!.response_format).toBeUndefined()
  })

  it('设置思考强度时发送 reasoning_effort，不发 temperature；不设置时不发送', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response(JSON.stringify({ choices: [{ message: { content: ok } }] }))
    }) as unknown as typeof fetch
    const opts = { baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm', fetch: fetchFn }
    await new OpenAiLlm({ ...opts, reasoningEffort: 'high' }).review(input)
    await new OpenAiLlm({ ...opts, reasoningEffort: null }).review(input)
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' })
    expect(bodies[0]).not.toHaveProperty('temperature')
    expect(bodies[1]).toMatchObject({ temperature: 0.2 })
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })
})

describe('LLM 调用详情', () => {
  /** 按顺序返回给定的响应体（对象会转成 JSON） */
  function reviewerWith(...responses: Array<object | Response>) {
    const fetchFn = (async () => {
      const next = responses.length > 1 ? responses.shift()! : responses[0]!
      return next instanceof Response ? next : new Response(JSON.stringify(next))
    }) as unknown as typeof fetch
    return new OpenAiLlm({ baseUrl: 'http://llm.local/v1', apiKey: 'secret-llm-key-XYZ', model: 'm', reasoningEffort: 'high', fetch: fetchFn })
  }

  it('记录思考过程（reasoning_content）、token 用量、模型和提示词，不含 API Key', async () => {
    const r = await reviewerWith({
      model: 'deepseek-x',
      choices: [{ message: { content: ok, reasoning_content: '先看均线……' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: 250 } }
    }).review(input)
    expect(r.valid).toBe(true)
    expect(r.prompt.user).toBe(buildUserPrompt(input))
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatchObject({
      model: 'm',
      responseModel: 'deepseek-x',
      reasoningEffort: 'high',
      jsonMode: true,
      httpStatus: 200,
      finishReason: 'stop',
      reasoning: '先看均线……',
      content: ok,
      usage: { promptTokens: 900, completionTokens: 300, reasoningTokens: 250, totalTokens: 1200 },
      error: null
    })
    expect(r.calls[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(r)).not.toContain('secret-llm-key-XYZ')
  })

  it.each([
    ['reasoning（OpenRouter 等）', { content: ok, reasoning: '思路 A' }, '思路 A'],
    ['reasoning_details', { content: ok, reasoning_details: [{ text: '第一步' }, { summary: '第二步' }] }, '第一步\n第二步'],
    ['正文开头的 <think>', { content: `<think>\n想一想\n</think>\n${ok}` }, '想一想'],
    ['没有思考过程', { content: ok }, null]
  ])('思考过程来自 %s', async (_name, message, expected) => {
    const r = await reviewerWith({ choices: [{ message }] }).review(input)
    expect(r.valid).toBe(true)
    expect(r.calls[0]!.reasoning).toBe(expected)
    expect(r.calls[0]!.content).toBe(ok)
  })

  it('splitThink 只拆开头的 <think>', () => {
    expect(splitThink(`<think>a</think>${ok}`)).toEqual({ content: ok, think: 'a' })
    expect(splitThink(ok)).toEqual({ content: ok, think: null })
  })

  it('过长的思考过程截断并注明', async () => {
    const long = '想'.repeat(MAX_SAVED_CHARS + 10)
    const r = await reviewerWith({ choices: [{ message: { content: ok, reasoning_content: long } }] }).review(input)
    expect(r.calls[0]!.reasoning!.startsWith('想'.repeat(MAX_SAVED_CHARS))).toBe(true)
    expect(r.calls[0]!.reasoning).toContain(`已截断，原文共 ${MAX_SAVED_CHARS + 10} 字`)
  })

  it('每次请求都有记录：不支持 response_format、输出不合格、HTTP 错误', async () => {
    const r = await reviewerWith(
      new Response('{"error":"response_format is not supported"}', { status: 400 }),
      { choices: [{ message: { content: '不是 JSON' } }] },
      new Response('busy', { status: 503 })
    ).review(input)
    expect(r.valid).toBe(false)
    expect(r.calls.map(c => [c.httpStatus, c.jsonMode])).toEqual([[400, true], [200, false], [503, false]])
    expect(r.calls[0]!.error).toMatch(/response_format/)
    expect(r.calls[1]!.error).toMatch(/输出不合格/)
    expect(r.calls[2]!.error).toMatch(/HTTP 503/)
  })

  it('网络错误也有记录', async () => {
    const r = await new MockLlm([new TypeError('fetch failed')]).review(input)
    expect(r.calls).toHaveLength(2)
    expect(r.calls.every(c => /网络错误/.test(c.error!) && c.httpStatus === null)).toBe(true)
  })
})
