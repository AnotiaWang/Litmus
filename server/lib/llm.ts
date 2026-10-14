/**
 * LLM：OpenAI 兼容接口的客户端，每个参赛模型一个实例。
 *
 * 把行情、账本和持仓交给大模型，由它决定买入 / 卖出 / 观望和比例。结果要经过风控；
 * 止损由程序每轮检查，LLM 出错或没被询问时持仓也有人管。
 * 任何异常（超时、返回不是合法 JSON、数值越界）重试 1 次，仍失败就按观望处理。
 *
 * 接口是 OpenAI 兼容的 /chat/completions，不引入 SDK，直接用 fetch。
 * 可选的思考强度通过 reasoning_effort 参数传给推理模型；各家不同的参数可以用“额外请求参数”合并进请求体。
 *
 * 每次请求都会留一条记录（耗时、token 用量、思考过程、输出、错误），连同提示词一起写进决策记录，
 * 方便在面板上看 LLM 到底是怎么想的。记录里不含请求头（里面有 API Key）。
 */
import Decimal from 'decimal.js'
import { z } from 'zod'
import type { LlmCall, LlmPrompt, LlmStatus } from '../../shared/types/api'
import type { Kline } from './market'
import type { MarketStats, StrategyParams } from './strategy'

/** 行情部分：K 线和程序算好的行情摘要 */
export interface MarketInput {
  klineInterval: string
  /** 最近若干根已收盘 K 线 */
  klines: Kline[]
  /** 上面的 K 线覆盖不到两周时附上的最近若干根已收盘日线，让模型看到更长周期的走势；否则为空 */
  dailyKlines: Kline[]
  stats: MarketStats
}

const ACTION_LABELS = { buy: '买入', sell: '卖出', hold: '观望' } as const
const OUTCOME_LABELS: Record<string, string> = { hold: '观望', filled: '已成交', risk_block: '风控拦截', paused: '暂停中', error: '出错' }

/** 时间都是 UTC。当前时间写完整的 2026-10-08 08:00；K 线、决策和成交列表里省略年份（10-08 08:00），省 token */
const fmtTime = (t: number | string) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const fmtShort = (t: number | string) => new Date(t).toISOString().slice(5, 16).replace('T', ' ')
const fmtDay = (t: number | string) => new Date(t).toISOString().slice(5, 10)
/** 去掉交易所返回值的尾零，如 83102.00000000 → 83102 */
const trim = (v: string) => new Decimal(v).toFixed()
/** 算不出来（数据不足）时注明 */
const trimOpt = (v: string | null) => v ? trim(v) : '-'
/** 程序算出的统计量保留 6 位有效数字 */
const fmtNum = (n: number) => Number.isFinite(n) ? new Decimal(n).toSignificantDigits(6).toFixed() : '数据不足'
/** 涨跌幅带正负号 */
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
/** USDT 金额保留两位小数 */
const fmtUsdt = (v: string | null) => v ? new Decimal(v).toFixed(2) : '-'

/** 一根 K 线一行：时间 开 高 低 收 成交量（列名写在表头，不在每行重复） */
function klineLines(klines: Kline[], time: (t: number) => string): string {
  return klines.map(k =>
    `${time(k.openTime)} ${trim(k.open)} ${trim(k.high)} ${trim(k.low)} ${trim(k.close)} ${new Decimal(k.volume).toSignificantDigits(6).toFixed()}`
  ).join('\n')
}

/**
 * 行情摘要只给描述行情的统计量（涨跌、高低点、波动、成交量），不给均线、RSI 这类指标：
 * 它们是均线基线的判断依据，又各自带着现成的买卖规则（金叉死叉、超买超卖），给了 LLM 会被直接套用，
 * 各模型的决策跟着趋同，比出来的就不是模型自己的判断了。
 */
function marketText(m: MarketInput): string {
  const { stats } = m
  const hours = Number(stats.hours.toFixed(1))
  const close = Number(m.klines.at(-1)!.close)
  const lines = [
    `- 涨跌幅：${[...stats.changes, { hours, pct: stats.changePct }].map(c => `最近 ${c.hours} 小时 ${fmtPct(c.pct)}`).join('，')}`,
    `- 最近 ${hours} 小时最高 ${fmtNum(stats.high)}，最低 ${fmtNum(stats.low)}；最新收盘比最高 ${fmtPct(stats.fromHighPct)}，比最低 ${fmtPct(stats.fromLowPct)}`
  ]
  if (Number.isFinite(stats.atr)) lines.push(`- ATR14 ${fmtNum(stats.atr)}（约为价格的 ${(stats.atr / close * 100).toFixed(2)}%）`)
  if (Number.isFinite(stats.volumeRatio)) lines.push(`- 最新一根成交量是之前 20 根平均的 ${stats.volumeRatio.toFixed(2)} 倍`)
  const daily = m.dailyKlines.length
    ? `\n\n最近 ${m.dailyKlines.length} 根日线（UTC 日期，已收盘；每行依次是日期、开、高、低、收、成交量）：\n${klineLines(m.dailyKlines, fmtDay)}`
    : ''
  return `行情摘要（${m.klineInterval} K 线，程序根据已收盘 K 线计算）：
${lines.join('\n')}${daily}

最近 ${m.klines.length} 根 ${m.klineInterval} K 线（UTC 开盘时间；每行依次是时间、开、高、低、收、成交量）：
${klineLines(m.klines, fmtShort)}`
}

function stopRulesText({ stopLossPct, trailingStopPct }: DecideInput['stopRules']): string {
  return [
    stopLossPct > 0 ? `跌破持仓均价 ${stopLossPct}% 止损` : '止损关闭',
    trailingStopPct > 0 ? `从持仓以来最高价回落 ${trailingStopPct}% 止损` : '移动止损关闭'
  ].join('，')
}

export interface DecideInput extends MarketInput {
  symbol: string
  baseAsset: string
  /** 询问频率的说明，如“每根 4h K 线收盘后” */
  cadence: string
  now: string
  price: string
  ledger: { usdt: string, base: string, positionValue: string, equity: string }
  /** 空仓时为 null */
  position: { entryPrice: string, pnlPct: string, peakPrice: string, stopPrice: string | null } | null
  stopRules: Pick<StrategyParams, 'stopLossPct' | 'trailingStopPct'>
  /** maxBuyUsdt：单笔上限、可用 USDT、仓位上限三者取最小后，现在最多能买多少；minOrderUsdt：交易所最小下单额 */
  limits: { maxBuyUsdt: string, maxOrderPct: number, minOrderUsdt: string, maxPositionPct: number }
  /** 现在不能买入 / 卖出的原因；可以时为 null */
  blocked: { buy: string | null, sell: string | null }
  recentDecisions: Array<{ time: string, price: string | null, action: string, sizePct: number | null, outcome: string, reason: string | null }>
  recentFills: Array<{ time: string, side: 'buy' | 'sell', price: string | null, qty: string | null, quote: string | null }>
}

export interface DecideResult {
  action: 'buy' | 'sell' | 'hold'
  /** 买入：动用账本可用 USDT 的比例；卖出：卖掉持币的比例；观望为 0 */
  sizePct: number
  confidence: number
  reason: string
  /** LLM 原始返回（重试时多次返回用分隔线拼接），便于事后排查 */
  raw: string | null
  /** ok 表示给出了合法结果；否则是程序代为观望，并区分是输出不合格还是请求失败 */
  status: LlmStatus
  error?: string
  /** 每次请求的详情，按时间顺序 */
  calls: LlmCall[]
  prompt: LlmPrompt
}

export interface Decider {
  decide(input: DecideInput): Promise<DecideResult>
}

export const DECIDE_SYSTEM_PROMPT = `你是一名加密货币现货交易员，独立管理一个账本里的资金。你和其他交易员在同一段行情里、按同样的规则交易，最后按收益比较成绩，回撤也会被统计。每次被询问时，你根据行情、账本和持仓决定这次买入、卖出还是观望，以及动用多少比例。

规则：
1. 只做现货多头：买入是用 USDT 买币，卖出是把持有的币换回 USDT。不能做空，不能加杠杆。
2. size_pct（0~100）：买入时表示动用账本可用 USDT 的比例；卖出时表示卖掉所持币的比例（100 为全部卖出）；观望填 0。
3. 按本轮的当前价格成交，每笔收取 0.1% 手续费。
4. 程序会在你的决定之上执行风控（单笔上限、仓位上限、每日次数、冷却时间、亏损熔断），风控只会调小金额或拦下交易。提示词里会写明现在哪些操作不可用。
5. 程序每轮都会检查止损线，跌破时自动全部卖出；你也可以随时主动卖出。
6. 每笔下单金额不能低于交易所最小下单额，比例太小时这笔不会下单；卖出后剩下的币低于最小下单额也卖不掉。
7. 提示词里的行情摘要由程序算好，可以直接引用，不必自己从 K 线推算。

只输出一个 JSON 对象，不要输出其他文字。先写理由再给结论，格式如下：
{"reason": "中文理由，100字以内，指出具体依据", "action": "buy" 或 "sell" 或 "hold", "size_pct": 0到100的数字, "confidence": 0到1的数字，表示你对这个判断的把握，0.5 表示拿不准}`

export function buildDecidePrompt(input: DecideInput): string {
  const pos = input.position
  const positionText = pos
    ? `持仓均价 ${pos.entryPrice}（含手续费），浮动盈亏 ${pos.pnlPct}%，持仓以来最高价 ${pos.peakPrice}，当前止损线 ${pos.stopPrice ?? '无（止损已关闭）'}`
    : '空仓'
  const can = (reason: string | null) => reason ? `不可以（${reason}）` : '可以'
  const recent = input.recentDecisions.length
    ? input.recentDecisions.map(d =>
        `${fmtShort(d.time)} 价格${trimOpt(d.price)} ${ACTION_LABELS[d.action as keyof typeof ACTION_LABELS] ?? d.action}${d.sizePct ? ` ${d.sizePct}%` : ''} 结果${OUTCOME_LABELS[d.outcome] ?? d.outcome} 理由：${d.reason ?? '-'}`
      ).join('\n')
    : '（暂无）'
  const fills = input.recentFills.length
    ? input.recentFills.map(f => `${fmtShort(f.time)} ${ACTION_LABELS[f.side]} ${trimOpt(f.qty)} ${input.baseAsset}，金额 ${fmtUsdt(f.quote)} USDT，价格 ${trimOpt(f.price)}`).join('\n')
    : '（暂无）'
  return `交易对：${input.symbol}
当前时间（UTC）：${fmtTime(input.now)}
当前价格：${input.price}
询问频率：${input.cadence}询问你一次；两次询问之间程序只检查止损

账本：可用 ${input.ledger.usdt} USDT，持有 ${input.ledger.base} ${input.baseAsset}（市值 ${input.ledger.positionValue} USDT），总资产 ${input.ledger.equity} USDT
持仓：${positionText}
止损规则：${stopRulesText(input.stopRules)}
风控限制：单笔买入不超过总资产的 ${input.limits.maxOrderPct}%，持币市值不超过总资产的 ${input.limits.maxPositionPct}%，每笔不能低于交易所最小下单额 ${input.limits.minOrderUsdt} USDT；算上可用 USDT，现在最多还能买入 ${input.limits.maxBuyUsdt} USDT
现在能否买入：${can(input.blocked.buy)}
现在能否卖出：${can(input.blocked.sell)}

${marketText(input)}

你最近的决策：
${recent}

最近的成交：
${fills}

请做出这次的决策。`
}

/** 去掉 ```json 代码块包裹后按 JSON 解析；不是合法 JSON 时抛错。 */
function parseJson(content: string): unknown {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('返回的不是合法 JSON')
  }
}

const decisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold']),
  size_pct: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
}).refine(v => v.action === 'hold' || v.size_pct > 0, { path: ['size_pct'], message: '买入 / 卖出时必须大于 0' })

/** 解析 LLM 决策；观望时比例统一记为 0。容忍 ```json 代码块包裹。 */
export function parseDecision(content: string): Pick<DecideResult, 'action' | 'sizePct' | 'confidence' | 'reason'> {
  const r = decisionSchema.safeParse(parseJson(content))
  if (!r.success) {
    throw new Error(`字段不合法：${r.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('；')}`)
  }
  return {
    action: r.data.action,
    sizePct: r.data.action === 'hold' ? 0 : r.data.size_pct,
    confidence: r.data.confidence,
    reason: r.data.reason.slice(0, 200)
  }
}

/** 汇总一次询问（含重试）的总耗时和 token 用量，用于排行榜统计 */
export function summarizeCalls(calls: LlmCall[]): { durationMs: number, promptTokens: number | null, completionTokens: number | null } {
  const sum = (pick: (c: LlmCall) => number | null | undefined) => {
    const values = calls.map(pick).filter((v): v is number => typeof v === 'number')
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  return {
    durationMs: calls.reduce((a, c) => a + c.durationMs, 0),
    promptTokens: sum(c => c.usage?.promptTokens),
    completionTokens: sum(c => c.usage?.completionTokens)
  }
}

/** 思考过程和输出最多保存这么多字，超出部分截断（推理模型的思考可能有上万字，每轮都存会让数据库涨得很快） */
export const MAX_SAVED_CHARS = 8000

function clip(text: string | null): string | null {
  if (text === null || text.length <= MAX_SAVED_CHARS) return text
  return `${text.slice(0, MAX_SAVED_CHARS)}\n…（已截断，原文共 ${text.length} 字）`
}

interface ChatMessage {
  content?: unknown
  /** DeepSeek、通义千问、vLLM 等 */
  reasoning_content?: unknown
  /** OpenRouter、新版 vLLM 等 */
  reasoning?: unknown
  /** OpenRouter 的结构化思考 */
  reasoning_details?: Array<{ text?: unknown, summary?: unknown }>
}

interface ChatResponse {
  model?: unknown
  choices?: Array<{ message?: ChatMessage, finish_reason?: unknown }>
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
    completion_tokens_details?: { reasoning_tokens?: unknown }
  }
}

const str = (v: unknown) => typeof v === 'string' && v ? v : null
const num = (v: unknown) => typeof v === 'number' ? v : null

/** 不同服务放思考过程的字段不一样，按常见程度依次找 */
function reasoningOf(message: ChatMessage): string | null {
  const details = message.reasoning_details?.map(d => str(d.text) ?? str(d.summary)).filter(Boolean).join('\n')
  return str(message.reasoning_content) ?? str(message.reasoning) ?? (details || null)
}

/** 有的模型把思考过程用 <think>…</think> 写在正文开头，拆出来，正文才能按 JSON 解析 */
export function splitThink(content: string): { content: string, think: string | null } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(content)
  return m ? { content: content.slice(m[0].length), think: m[1]!.trim() || null } : { content, think: null }
}

function usageOf(u: ChatResponse['usage']): LlmCall['usage'] {
  if (!u) return null
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    totalTokens: num(u.total_tokens)
  }
}

export interface OpenAiLlmOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 思考强度，原样作为 reasoning_effort 发送；不设置时不发送，用模型默认值 */
  reasoningEffort?: string | null
  /** 原样合并进请求体（最后合并，可以覆盖 temperature 等默认值） */
  extraParams?: Record<string, unknown> | null
  timeoutMs?: number
  fetch?: typeof fetch
}

type Asked<T>
  = | { ok: true, value: T, raw: string, calls: LlmCall[] }
    | { ok: false, error: string, raw: string | null, calls: LlmCall[] }

export class OpenAiLlm implements Decider {
  /** 有的兼容服务不支持 response_format，遇到 400 后关掉，之后不再发送 */
  private jsonMode = true
  private readonly fetchFn: typeof fetch

  constructor(private readonly opts: OpenAiLlmOptions) {
    this.fetchFn = opts.fetch ?? fetch
  }

  async decide(input: DecideInput): Promise<DecideResult> {
    const prompt: LlmPrompt = { system: DECIDE_SYSTEM_PROMPT, user: buildDecidePrompt(input) }
    const r = await this.ask(prompt, parseDecision)
    if (r.ok) return { ...r.value, raw: r.raw, status: 'ok', calls: r.calls, prompt }
    return {
      action: 'hold',
      sizePct: 0,
      confidence: 0,
      reason: '程序代为观望：LLM 未返回合法结果',
      raw: r.raw,
      // 拿到过正文说明服务是通的，是模型没按要求输出；一次都没拿到就是请求失败
      status: r.calls.some(c => c.content !== null) ? 'invalid_output' : 'request_failed',
      error: r.error,
      calls: r.calls,
      prompt
    }
  }

  /** 发送提示词并解析，出错或不合格时重试 1 次。原始返回（多次时用分隔线拼接）和每次请求的记录都带回去。 */
  private async ask<T>(prompt: LlmPrompt, parse: (content: string) => T): Promise<Asked<T>> {
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ]
    const calls: LlmCall[] = []
    const raws: string[] = []
    const errors: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      let content: string
      try {
        content = await this.complete(messages, calls)
      } catch (e) {
        errors.push((e as Error).message)
        continue
      }
      raws.push(content)
      try {
        return { ok: true, value: parse(content), raw: raws.join('\n---\n'), calls }
      } catch (e) {
        errors.push((e as Error).message)
        calls.at(-1)!.error = `输出不合格：${(e as Error).message}`
      }
    }
    return { ok: false, error: `LLM 两次都没有给出合法结果：${errors.join('；')}`, raw: raws.length ? raws.join('\n---\n') : null, calls }
  }

  /** 发一次请求，返回正文（已去掉 <think>）。每次请求都往 calls 里追加一条记录，失败时记下原因再抛出。 */
  private async complete(messages: Array<{ role: string, content: string }>, calls: LlmCall[]): Promise<string> {
    const body: Record<string, unknown> = { model: this.opts.model, messages }
    // 推理模型大多不接受自定义 temperature，设置了思考强度时就不发
    if (this.opts.reasoningEffort) body.reasoning_effort = this.opts.reasoningEffort
    else body.temperature = 0.2
    if (this.jsonMode) body.response_format = { type: 'json_object' }
    Object.assign(body, this.opts.extraParams)

    const call: LlmCall = {
      startedAt: new Date().toISOString(),
      durationMs: 0,
      model: this.opts.model,
      responseModel: null,
      reasoningEffort: this.opts.reasoningEffort ?? null,
      jsonMode: this.jsonMode,
      httpStatus: null,
      finishReason: null,
      reasoning: null,
      content: null,
      usage: null,
      error: null
    }
    calls.push(call)
    const started = Date.now()
    const fail = (message: string, cause?: unknown): never => {
      call.error = message
      throw new Error(message, { cause })
    }

    let res: Response
    try {
      res = await this.fetchFn(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
      })
    } catch (e) {
      call.durationMs = Date.now() - started
      const name = (e as Error).name
      return fail(name === 'TimeoutError' || name === 'AbortError' ? 'LLM 请求超时' : `LLM 网络错误：${(e as Error).message}`, e)
    }
    const text = await res.text()
    call.durationMs = Date.now() - started
    call.httpStatus = res.status
    if (res.status === 400 && this.jsonMode && /response_format|json_object/i.test(text)) {
      call.error = '服务不支持 response_format，已去掉后重发'
      this.jsonMode = false
      return this.complete(messages, calls)
    }
    if (!res.ok) fail(`LLM 接口返回 HTTP ${res.status}：${text.slice(0, 200)}`)
    let data: ChatResponse
    try {
      data = JSON.parse(text)
    } catch {
      return fail('LLM 接口返回的不是 JSON')
    }
    const choice = data.choices?.[0]
    call.responseModel = str(data.model)
    call.finishReason = str(choice?.finish_reason)
    call.usage = usageOf(data.usage)
    const message = choice?.message
    if (typeof message?.content !== 'string') return fail('LLM 返回里没有 choices[0].message.content')
    const { content, think } = splitThink(message.content)
    call.reasoning = clip(reasoningOf(message) ?? think)
    call.content = clip(content)
    return content
  }
}

/** 模拟 LLM：依次返回预设的原始文本（或抛错），用完后重复最后一个。用于测试。 */
export class MockLlm implements Decider {
  calls: DecideInput[] = []
  private readonly fake = new OpenAiLlm({ baseUrl: 'http://mock', apiKey: 'mock', model: 'mock', fetch: (() => this.fakeFetch()) as unknown as typeof fetch })

  constructor(public responses: Array<string | Error> = ['{"action":"hold","size_pct":0,"confidence":0.5,"reason":"测试观望"}']) {}

  async decide(input: DecideInput): Promise<DecideResult> {
    this.calls.push(input)
    return this.fake.decide(input)
  }

  private async fakeFetch(): Promise<Response> {
    const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0]!
    if (next instanceof Error) throw next
    return new Response(JSON.stringify({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200 })
  }
}

/** 列出 Provider 提供的模型（GET /models），管理页面新建模型时用来选择。失败时抛出带原因的错误。 */
export async function listModels(baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  let res: Response
  try {
    res = await fetchFn(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    const name = (e as Error).name
    throw new Error(name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : `网络错误：${(e as Error).message}`, { cause: e })
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
  let data: { data?: Array<{ id?: unknown }> }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('返回的不是 JSON')
  }
  return (data.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string').sort()
}
