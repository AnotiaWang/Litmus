import { describe, expect, it } from 'vitest'
import { buildDecidePrompt, DECIDE_SYSTEM_PROMPT, listModels, MAX_SAVED_CHARS, MockLlm, OpenAiLlm, parseDecision, splitThink, summarizeCalls, type DecideInput } from '../../server/lib/llm'
import { marketStats } from '../../server/lib/strategy'
import { makeKlines } from './helpers'

const klines = makeKlines(Array.from({ length: 24 }, (_, i) => 59000 + i * 10), Date.UTC(2026, 9, 8))

const input: DecideInput = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  klineInterval: '4h',
  cadence: '每根 4h K 线收盘后',
  now: '2026-10-08T12:00:00.000Z',
  price: '60000',
  klines,
  dailyKlines: [],
  stats: marketStats(klines),
  ledger: { usdt: '40.00', base: '0.001', positionValue: '60.00', equity: '100.00' },
  position: { entryPrice: '58000', pnlPct: '3.45', peakPrice: '61000', stopPrice: '55100', unrealizedPnl: '2.00', holdingHours: 4, stopDistancePct: '8.17', stopDistanceAtr: '12.3' },
  stopRules: { stopLossPct: 5, trailingStopPct: 0 },
  limits: { maxBuyUsdt: '20.00', maxOrderPct: 50, minOrderUsdt: '5', maxPositionPct: 80, maxTradesPerDay: 6, cooldownMinutes: 60, dailyLossLimitPct: 5 },
  blocked: { buy: '交易冷却时间：距上一笔成交仅 10 分钟，需间隔 60 分钟', sell: null },
  riskState: { tradesToday: 0, cooldownRemainingMinutes: 50, circuit: null },
  accounting: { realizedPnl: '1.00', fees: '0.50' },
  recentDecisions: [{ time: '2026-10-08T08:00:00.000Z', price: '58000', action: 'buy', sizePct: 60, outcome: 'filled', reason: '趋势向上' }],
  recentFills: [{ time: '2026-10-08T08:00:00.000Z', side: 'buy', price: '58000', qty: '0.001', quote: '58', realizedPnl: null }]
}

const ok = '{"reason":"趋势转强","action":"buy","size_pct":40,"confidence":0.7}'

describe('解析 LLM 决策', () => {
  it('合法 JSON；观望时比例记为 0；容忍 ```json 代码块', () => {
    expect(parseDecision('{"action":"sell","size_pct":50,"confidence":0.6,"reason":"转弱"}')).toEqual({ action: 'sell', sizePct: 50, confidence: 0.6, reason: '转弱' })
    expect(parseDecision('```json\n{"action":"hold","size_pct":30,"confidence":0.6,"reason":"等等"}\n```').sizePct).toBe(0)
  })

  it.each([
    ['非 JSON', '我觉得可以买'],
    ['action 非法', '{"action":"approve","size_pct":10,"confidence":0.5,"reason":"x"}'],
    ['买入比例为 0', '{"action":"buy","size_pct":0,"confidence":0.5,"reason":"x"}'],
    ['size_pct 越界', '{"action":"sell","size_pct":120,"confidence":0.5,"reason":"x"}'],
    ['confidence 越界', '{"action":"sell","size_pct":10,"confidence":2,"reason":"x"}'],
    ['缺少 reason', '{"action":"hold","size_pct":0,"confidence":0.5}']
  ])('%s 时报错', (_name, text) => {
    expect(() => parseDecision(text)).toThrow()
  })
})

describe('提示词', () => {
  it('包含询问频率、账本、持仓、止损、限额、能否买卖、行情摘要、K 线和最近的决策', () => {
    const prompt = buildDecidePrompt(input)
    for (const s of [
      'BTCUSDT',
      '当前时间（UTC）：2026-10-08 12:00',
      '每根 4h K 线收盘后询问你一次',
      '可用 40.00 USDT，持有 0.001 BTC（市值 60.00 USDT），总资产 100.00 USDT',
      '持仓均价 58000（含手续费），浮动盈亏 3.45%（+2.00 USDT）',
      '当前止损线 55100',
      '跌破持仓均价 5% 止损，移动止损关闭',
      '风控规则：单笔买入≤总资产的 50%，持币≤总资产的 80%，每日最多 6 笔，冷却 60 分钟，当日亏损 5% 熔断；最小下单额 5 USDT',
      '风控状态：今日已成交 0 笔（剩余 6 笔），冷却剩余 50 分钟，未熔断',
      '本赛季：累计已实现盈亏 +1.00 USDT，累计手续费 0.50 USDT',
      '本轮可执行：不可买（交易冷却时间',
      '可卖 0.001 BTC',
      '涨跌幅：最近 1 小时 +0.00%，最近 4 小时 +0.05%，最近 12 小时 +0.19%，最近 24 小时 +0.39%',
      '最近 24 小时最高 59822.3，最低 58410；最新收盘比最高 -0.99%，比最低 +1.40%',
      'ATR14',
      '最新一根成交量是之前 20 根平均的 1.00 倍',
      '最近 24 根 4h K 线（UTC 开盘时间；每行依次是时间、开、高、低、收、成交量）：',
      '\n10-07 23:00 59230 59822.3 58637.7 59230 1\n',
      '10-08 08:00 价格58000 买入 60% 结果已成交 理由：趋势向上',
      '10-08 08:00 买入 0.001 BTC，金额 58.00 USDT，价格 58000'
    ]) {
      expect(prompt).toContain(s)
    }
  })

  it('不给均线、RSI 这类基线用的指标；没有日线时不写日线', () => {
    const prompt = buildDecidePrompt(input)
    for (const s of ['SMA', 'RSI', '均线', '日线']) expect(prompt).not.toContain(s)
  })

  it('附上日线时放在主 K 线前面，只写日期', () => {
    const day = 86_400_000
    const daily = [2, 1].map(n => ({ ...klines[0]!, openTime: Date.UTC(2026, 9, 8) - n * day, closeTime: Date.UTC(2026, 9, 8) - (n - 1) * day - 1, open: '58000', high: '61000', low: '57000', close: '60000', volume: '12345.678' }))
    const prompt = buildDecidePrompt({ ...input, dailyKlines: daily })
    expect(prompt).toContain('最近 2 根日线（UTC 日期，已收盘；每行依次是日期、开、高、低、收、成交量）：\n10-06 58000 61000 57000 60000 12345.7\n10-07 58000')
    expect(prompt.indexOf('根日线')).toBeLessThan(prompt.indexOf('最近 24 根 4h K 线'))
  })

  it('交易所返回值的尾零去掉；数据不足算不出的统计量不写', () => {
    const k = { ...klines.at(-1)!, open: '83102.00000000', high: '83173.29000000', low: '83099.34000000', close: '83129.92000000', volume: '186.14116000' }
    const prompt = buildDecidePrompt({ ...input, klines: [k], stats: marketStats([k]) })
    expect(prompt).toContain('83102 83173.29 83099.34 83129.92 186.141')
    expect(prompt).toContain('涨跌幅：最近 1 小时 +0.03%\n')
    expect(prompt).not.toContain('ATR14')
    expect(prompt).not.toContain('成交量是之前')
  })

  it('空仓、止损关闭时写明', () => {
    const prompt = buildDecidePrompt({ ...input, position: null, stopRules: { stopLossPct: 0, trailingStopPct: 3 }, recentDecisions: [], recentFills: [] })
    expect(prompt).toContain('持仓：空仓')
    expect(prompt).toContain('止损关闭，从持仓以来最高价回落 3% 止损')
    expect(prompt).toContain('你最近的决策（从早到晚）：\n（暂无）')
  })

  it('系统提示词是中性的目标描述；输出格式先写理由再给结论', () => {
    expect(DECIDE_SYSTEM_PROMPT).not.toContain('激进')
    expect(DECIDE_SYSTEM_PROMPT).not.toContain('指标')
    expect(DECIDE_SYSTEM_PROMPT).toContain('按收益比较成绩，回撤也会被统计')
    expect(DECIDE_SYSTEM_PROMPT.indexOf('"reason"')).toBeLessThan(DECIDE_SYSTEM_PROMPT.indexOf('"action"'))
  })
})

describe('LLM 决策', () => {
  it('第一次非法、第二次合法：采用第二次结果，原始返回都保留', async () => {
    const r = await new MockLlm(['不是 JSON', ok]).decide(input)
    expect(r).toMatchObject({ action: 'buy', sizePct: 40, status: 'ok' })
    expect(r.raw).toContain('不是 JSON')
    expect(r.raw).toContain('趋势转强')
    expect(r.prompt.user).toBe(buildDecidePrompt(input))
  })

  it('两次都不合格：程序代为观望，记为“输出不合格”', async () => {
    const r = await new MockLlm(['{"action":"buy","size_pct":101,"confidence":1,"reason":"x"}']).decide(input)
    expect(r).toMatchObject({ action: 'hold', sizePct: 0, status: 'invalid_output' })
    expect(r.raw).toContain('101')
    expect(r.error).toMatch(/size_pct/)
    expect(r.calls).toHaveLength(2)
  })

  it('输出被截断（finish_reason=length）：记为输出不合格，不重试', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"buy"' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }))) as unknown as typeof fetch
    const r = await new OpenAiLlm({ baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm', fetch: fetchFn }).decide(input)
    expect(r).toMatchObject({ action: 'hold', status: 'invalid_output', attempts: 1 })
    expect(r.calls).toHaveLength(1)
    expect(r.error).toContain('输出被截断')
    expect(r.error).not.toContain('两次')
    expect(r.calls[0]!.error).toContain('输出被截断')
  })

  it('标了 finish_reason=length 但正文是完整的 JSON：照常采用', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ choices: [{ message: { content: ok }, finish_reason: 'length' }] }))) as unknown as typeof fetch
    const r = await new OpenAiLlm({ baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm', fetch: fetchFn }).decide(input)
    expect(r).toMatchObject({ status: 'ok', action: 'buy', attempts: 1 })
  })

  it('两次都请求失败：程序代为观望，记为“请求失败”', async () => {
    const r = await new MockLlm([new TypeError('fetch failed')]).decide(input)
    expect(r).toMatchObject({ action: 'hold', status: 'request_failed', raw: null })
    expect(r.error).toMatch(/网络错误/)
    expect(r.calls.every(c => /网络错误/.test(c.error!) && c.httpStatus === null)).toBe(true)
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
    const r = await new OpenAiLlm({ baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm', fetch: fetchFn }).decide(input)
    expect(r.status).toBe('ok')
    expect(bodies[0]).toMatchObject({ model: 'm', temperature: 0.2, response_format: { type: 'json_object' } })
    expect(bodies[1]!.response_format).toBeUndefined()
    // 协议层面的重发不算重试
    expect(r).toMatchObject({ attempts: 1 })
    expect(r.calls).toHaveLength(2)
  })

  it('设置思考强度时发送 reasoning_effort，不发 temperature；额外请求参数原样合并，可以覆盖默认值', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response(JSON.stringify({ choices: [{ message: { content: ok } }] }))
    }) as unknown as typeof fetch
    const opts = { baseUrl: 'http://llm.local/v1', apiKey: 'k', model: 'm', fetch: fetchFn }
    await new OpenAiLlm({ ...opts, reasoningEffort: 'high' }).decide(input)
    await new OpenAiLlm({ ...opts, reasoningEffort: null, extraParams: { temperature: 0, thinking: { type: 'enabled' } } }).decide(input)
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' })
    expect(bodies[0]).not.toHaveProperty('temperature')
    expect(bodies[1]).toMatchObject({ temperature: 0, thinking: { type: 'enabled' } })
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('汇总一次询问的耗时和 token 用量', () => {
    const call = (durationMs: number, promptTokens: number | null) => ({ durationMs, usage: promptTokens === null ? null : { promptTokens, completionTokens: 10, reasoningTokens: null, totalTokens: null } })
    expect(summarizeCalls([call(100, 50), call(200, 60)] as never)).toEqual({ durationMs: 300, promptTokens: 110, completionTokens: 20 })
    expect(summarizeCalls([call(100, null)] as never)).toEqual({ durationMs: 100, promptTokens: null, completionTokens: null })
  })
})

describe('LLM 调用详情', () => {
  /** 按顺序返回给定的响应体（对象会转成 JSON） */
  function llmWith(...responses: Array<object | Response>) {
    const fetchFn = (async () => {
      const next = responses.length > 1 ? responses.shift()! : responses[0]!
      return next instanceof Response ? next : new Response(JSON.stringify(next))
    }) as unknown as typeof fetch
    return new OpenAiLlm({ baseUrl: 'http://llm.local/v1', apiKey: 'secret-llm-key-XYZ', model: 'm', reasoningEffort: 'high', fetch: fetchFn })
  }

  it('记录思考过程（reasoning_content）、token 用量、模型和提示词，不含 API Key', async () => {
    const r = await llmWith({
      model: 'deepseek-x',
      choices: [{ message: { content: ok, reasoning_content: '先看均线……' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: 250 } }
    }).decide(input)
    expect(r.status).toBe('ok')
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
    const r = await llmWith({ choices: [{ message }] }).decide(input)
    expect(r.status).toBe('ok')
    expect(r.calls[0]!.reasoning).toBe(expected)
    expect(r.calls[0]!.content).toBe(ok)
  })

  it('splitThink 只拆开头的 <think>', () => {
    expect(splitThink(`<think>a</think>${ok}`)).toEqual({ content: ok, think: 'a' })
    expect(splitThink(ok)).toEqual({ content: ok, think: null })
  })

  it('过长的思考过程截断并注明', async () => {
    const long = '想'.repeat(MAX_SAVED_CHARS + 10)
    const r = await llmWith({ choices: [{ message: { content: ok, reasoning_content: long } }] }).decide(input)
    expect(r.calls[0]!.reasoning!.startsWith('想'.repeat(MAX_SAVED_CHARS))).toBe(true)
    expect(r.calls[0]!.reasoning).toContain(`已截断，原文共 ${MAX_SAVED_CHARS + 10} 字`)
  })

  it('每次请求都有记录：不支持 response_format、输出不合格、HTTP 错误', async () => {
    const r = await llmWith(
      new Response('{"error":"response_format is not supported"}', { status: 400 }),
      { choices: [{ message: { content: '不是 JSON' } }] },
      new Response('busy', { status: 503 })
    ).decide(input)
    expect(r.status).toBe('invalid_output')
    expect(r.calls.map(c => [c.httpStatus, c.jsonMode])).toEqual([[400, true], [200, false], [503, false]])
    expect(r.calls[0]!.error).toMatch(/response_format/)
    expect(r.calls[1]!.error).toMatch(/输出不合格/)
    expect(r.calls[2]!.error).toMatch(/HTTP 503/)
  })
})

describe('模型列表', () => {
  it('读取 /models 返回的模型 ID 并排序', async () => {
    const fetchFn = (async (url: string, init: RequestInit) => {
      expect(url).toBe('http://llm.local/v1/models')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
      return new Response(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { name: 'no-id' }] }))
    }) as unknown as typeof fetch
    expect(await listModels('http://llm.local/v1', 'k', fetchFn)).toEqual(['a-model', 'b-model'])
  })

  it('HTTP 错误时报错', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(listModels('http://llm.local/v1', 'k', fetchFn)).rejects.toThrow('HTTP 401')
  })
})
