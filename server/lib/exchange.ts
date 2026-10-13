/**
 * 交易所客户端：只实现本项目用到的几个 Binance 现货接口，外加一个模拟实现供测试使用。
 *
 * - 请求用 Node 原生 fetch，签名用 node:crypto 的 HMAC-SHA256，不依赖交易所 SDK，便于看清每一步。
 * - 构造时校验地址白名单：即使有人绕过配置校验，也连不上真实交易环境。
 * - 本文件只有查询和下单接口，没有任何提现、划转、借贷相关调用（安全要求）。
 * - 下单用决策记录 ID 作为 newClientOrderId。网络出错时先按这个 ID 查一下订单是否已经成交，
 *   查不到才重新提交，避免“其实已经下单了，但我们没收到回复”导致重复下单。
 */
import { createHmac } from 'node:crypto'
import Decimal from 'decimal.js'
import { assertAllowedBinanceUrl } from './config'

export interface Kline {
  openTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  closeTime: number
}

/** 交易对规则：数量步长、最小数量、最小下单额（NOTIONAL 过滤器）。 */
export interface SymbolRules {
  symbol: string
  baseAsset: string
  quoteAsset: string
  stepSize: Decimal
  minQty: Decimal
  minNotional: Decimal
}

export interface Balance {
  free: Decimal
  locked: Decimal
}

export interface Commission {
  asset: string
  amount: Decimal
}

export interface OrderResult {
  orderId: string
  clientOrderId: string
  status: string
  /** 成交的币数量（未扣手续费） */
  executedQty: Decimal
  /** 成交的 USDT 金额（未扣手续费） */
  quoteQty: Decimal
  commissions: Commission[]
}

export interface Exchange {
  /** 校准本地与交易所的时间差，返回差值（毫秒，交易所时间 - 本地时间）。 */
  syncTime(): Promise<number>
  getSymbolRules(symbol: string): Promise<SymbolRules>
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>
  getPrice(symbol: string): Promise<Decimal>
  /** 账户余额（签名接口），只返回非零资产。 */
  getBalances(): Promise<Record<string, Balance>>
  /** 市价买入，按 USDT 金额（quoteOrderQty）。 */
  marketBuy(symbol: string, quoteAmount: Decimal, clientOrderId: string): Promise<OrderResult>
  /** 市价卖出，按币数量（quantity，需已按 stepSize 取整）。 */
  marketSell(symbol: string, quantity: Decimal, clientOrderId: string): Promise<OrderResult>
}

export class ExchangeError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number, readonly retryable = false) {
    super(message)
  }
}

/** 收到 429 / 418（请求过多 / IP 被临时封禁）。本轮直接结束，不重试。 */
export class RateLimitError extends ExchangeError {}

/** 数量按步长向下取整，例如 stepSize=0.00001 时 0.123456 → 0.12345。 */
export function floorToStep(qty: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return qty
  return qty.div(step).floor().mul(step)
}

/** 按 Binance 文档拼接签名原文：参数按给定顺序拼成 a=1&b=2，非 ASCII 字符百分号编码。 */
export function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

export function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex')
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface BinanceClientOptions {
  baseUrl: string
  apiKey: string
  apiSecret: string
  timeoutMs?: number
  /** 测试时可替换 */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

type Params = Record<string, string | number>

const RECV_WINDOW = 5000
const MAX_RETRIES = 3
const TIME_SYNC_INTERVAL_MS = 60 * 60 * 1000

export class BinanceClient implements Exchange {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private timeOffset = 0
  private lastSyncAt = 0
  private rulesCache = new Map<string, SymbolRules>()

  constructor(opts: BinanceClientOptions) {
    assertAllowedBinanceUrl(opts.baseUrl)
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.apiSecret = opts.apiSecret
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchFn = opts.fetch ?? fetch
    this.sleepFn = opts.sleep ?? sleep
  }

  async syncTime(): Promise<number> {
    const start = Date.now()
    const data = await this.withRetry(() => this.send('GET', '/api/v3/time', {}, false)) as { serverTime: number }
    const end = Date.now()
    // 用往返时间的一半近似单程延迟
    this.timeOffset = data.serverTime - Math.round((start + end) / 2)
    this.lastSyncAt = end
    return this.timeOffset
  }

  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const cached = this.rulesCache.get(symbol)
    if (cached) return cached
    const data = await this.withRetry(() => this.send('GET', '/api/v3/exchangeInfo', { symbol }, false)) as {
      symbols: Array<{ symbol: string, baseAsset: string, quoteAsset: string, filters: Array<Record<string, string>> }>
    }
    const info = data.symbols.find(s => s.symbol === symbol)
    if (!info) throw new ExchangeError(`交易所没有交易对 ${symbol}`)
    const lot = info.filters.find(f => f.filterType === 'LOT_SIZE')
    // 新版接口用 NOTIONAL，老版本用 MIN_NOTIONAL，两个都兼容
    const notional = info.filters.find(f => f.filterType === 'NOTIONAL') ?? info.filters.find(f => f.filterType === 'MIN_NOTIONAL')
    const rules: SymbolRules = {
      symbol,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      stepSize: new Decimal(lot?.stepSize ?? '0'),
      minQty: new Decimal(lot?.minQty ?? '0'),
      minNotional: new Decimal(notional?.minNotional ?? '0')
    }
    this.rulesCache.set(symbol, rules)
    return rules
  }

  /** startTime / endTime 可选，回测时用来分页拉取历史 K 线（每次最多 1000 根）。 */
  async getKlines(symbol: string, interval: string, limit: number, range: { startTime?: number, endTime?: number } = {}): Promise<Kline[]> {
    const params: Params = { symbol, interval, limit }
    if (range.startTime !== undefined) params.startTime = range.startTime
    if (range.endTime !== undefined) params.endTime = range.endTime
    const rows = await this.withRetry(() => this.send('GET', '/api/v3/klines', params, false)) as Array<Array<string | number>>
    return rows.map(r => ({
      openTime: Number(r[0]),
      open: String(r[1]),
      high: String(r[2]),
      low: String(r[3]),
      close: String(r[4]),
      volume: String(r[5]),
      closeTime: Number(r[6])
    }))
  }

  async getPrice(symbol: string): Promise<Decimal> {
    const data = await this.withRetry(() => this.send('GET', '/api/v3/ticker/price', { symbol }, false)) as { price: string }
    return new Decimal(data.price)
  }

  async getBalances(): Promise<Record<string, Balance>> {
    const data = await this.withRetry(() => this.send('GET', '/api/v3/account', { omitZeroBalances: 'true' }, true)) as {
      balances: Array<{ asset: string, free: string, locked: string }>
    }
    const out: Record<string, Balance> = {}
    for (const b of data.balances) out[b.asset] = { free: new Decimal(b.free), locked: new Decimal(b.locked) }
    return out
  }

  marketBuy(symbol: string, quoteAmount: Decimal, clientOrderId: string): Promise<OrderResult> {
    return this.placeOrder(symbol, clientOrderId, { side: 'BUY', quoteOrderQty: quoteAmount.toFixed() })
  }

  marketSell(symbol: string, quantity: Decimal, clientOrderId: string): Promise<OrderResult> {
    return this.placeOrder(symbol, clientOrderId, { side: 'SELL', quantity: quantity.toFixed() })
  }

  private async placeOrder(symbol: string, clientOrderId: string, extra: Params): Promise<OrderResult> {
    const params: Params = { symbol, type: 'MARKET', newClientOrderId: clientOrderId, newOrderRespType: 'FULL', ...extra }
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        // 上一次提交结果未知：先查订单是否已经存在，存在就直接用，避免重复下单
        const existing = await this.findOrder(symbol, clientOrderId)
        if (existing) return existing
      }
      try {
        const data = await this.send('POST', '/api/v3/order', params, true) as RawOrder
        return parseOrder(data)
      } catch (e) {
        if (!(e instanceof ExchangeError) || !e.retryable || attempt >= MAX_RETRIES) throw e
        await this.sleepFn(500 * 2 ** attempt)
      }
    }
  }

  /** 按 clientOrderId 查订单；不存在时返回 null。查到后再查成交明细拿到手续费。 */
  private async findOrder(symbol: string, clientOrderId: string): Promise<OrderResult | null> {
    let order: RawOrder
    try {
      order = await this.withRetry(() => this.send('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId }, true)) as RawOrder
    } catch (e) {
      // -2013：订单不存在
      if (e instanceof ExchangeError && e.code === -2013) return null
      throw e
    }
    const trades = await this.withRetry(() => this.send('GET', '/api/v3/myTrades', { symbol, orderId: String(order.orderId) }, true)) as Array<{ commission: string, commissionAsset: string }>
    return parseOrder({ ...order, fills: trades })
  }

  /** 网络错误、超时、5xx 时按指数退避重试，最多 3 次。 */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        if (!(e instanceof ExchangeError) || !e.retryable || attempt >= MAX_RETRIES) throw e
        await this.sleepFn(500 * 2 ** attempt)
      }
    }
  }

  /** 发送一次请求（不重试），把各种失败统一转换成 ExchangeError。 */
  private async send(method: 'GET' | 'POST', path: string, params: Params, signed: boolean, resynced = false): Promise<unknown> {
    let query: string
    const headers: Record<string, string> = {}
    if (signed) {
      if (Date.now() - this.lastSyncAt > TIME_SYNC_INTERVAL_MS) await this.syncTime()
      const unsigned = buildQuery({ ...params, recvWindow: RECV_WINDOW, timestamp: Date.now() + this.timeOffset })
      query = `${unsigned}&signature=${sign(unsigned, this.apiSecret)}`
      headers['X-MBX-APIKEY'] = this.apiKey
    } else {
      query = buildQuery(params)
    }
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`

    let res: Response
    try {
      res = await this.fetchFn(url, { method, headers, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      const name = (e as Error).name
      const reason = name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : `网络错误：${(e as Error).message}`
      throw new ExchangeError(`${method} ${path} ${reason}`, undefined, undefined, true)
    }

    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (res.ok) return body

    const code = typeof (body as { code?: unknown })?.code === 'number' ? (body as { code: number }).code : undefined
    const msg = (body as { msg?: string })?.msg ?? text.slice(0, 200)
    if (res.status === 429 || res.status === 418) {
      throw new RateLimitError(`交易所限流（HTTP ${res.status}）：${msg}`, res.status, code)
    }
    // -1021：时间戳超出 recvWindow，重新校准时间后再试一次
    if (signed && code === -1021 && !resynced) {
      await this.syncTime()
      return this.send(method, path, params, signed, true)
    }
    throw new ExchangeError(`${method} ${path} 失败（HTTP ${res.status}${code !== undefined ? `，code ${code}` : ''}）：${msg}`, res.status, code, res.status >= 500)
  }
}

interface RawOrder {
  orderId: number | string
  clientOrderId: string
  status: string
  executedQty: string
  cummulativeQuoteQty: string
  fills?: Array<{ commission: string, commissionAsset: string }>
}

function parseOrder(o: RawOrder): OrderResult {
  return {
    orderId: String(o.orderId),
    clientOrderId: o.clientOrderId,
    status: o.status,
    executedQty: new Decimal(o.executedQty),
    quoteQty: new Decimal(o.cummulativeQuoteQty),
    commissions: (o.fills ?? []).map(f => ({ asset: f.commissionAsset, amount: new Decimal(f.commission) }))
  }
}

/**
 * 模拟交易所：全部在内存里，按设定价格立即成交，手续费 0.1%（从买到的资产里扣）。
 * 测试里直接修改公开字段来构造各种场景。
 */
export class MockExchange implements Exchange {
  klines: Kline[] = []
  price = new Decimal('50000')
  balances: Record<string, Balance> = {
    USDT: { free: new Decimal('10000'), locked: new Decimal(0) },
    BTC: { free: new Decimal('1'), locked: new Decimal(0) }
  }

  rules: SymbolRules = {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    stepSize: new Decimal('0.00001'),
    minQty: new Decimal('0.00001'),
    minNotional: new Decimal('5')
  }

  feeRate = new Decimal('0.001')
  /** 设置后，下一次调用对应方法会抛出这个错误 */
  failOn: Partial<Record<'getKlines' | 'getPrice' | 'getBalances' | 'order', Error>> = {}
  orders: Array<{ side: 'BUY' | 'SELL', clientOrderId: string, result: OrderResult }> = []
  private nextOrderId = 1

  async syncTime(): Promise<number> {
    return 0
  }

  async getSymbolRules(): Promise<SymbolRules> {
    return this.rules
  }

  async getKlines(_symbol: string, _interval: string, limit: number): Promise<Kline[]> {
    this.maybeFail('getKlines')
    return this.klines.slice(-limit)
  }

  async getPrice(): Promise<Decimal> {
    this.maybeFail('getPrice')
    return this.price
  }

  async getBalances(): Promise<Record<string, Balance>> {
    this.maybeFail('getBalances')
    return Object.fromEntries(Object.entries(this.balances).map(([k, v]) => [k, { free: new Decimal(v.free), locked: new Decimal(v.locked) }]))
  }

  async marketBuy(_symbol: string, quoteAmount: Decimal, clientOrderId: string): Promise<OrderResult> {
    this.maybeFail('order')
    const qty = floorToStep(quoteAmount.div(this.price), this.rules.stepSize)
    const cost = qty.mul(this.price)
    const fee = qty.mul(this.feeRate)
    this.adjust(this.rules.quoteAsset, cost.neg())
    this.adjust(this.rules.baseAsset, qty.minus(fee))
    return this.record('BUY', clientOrderId, qty, cost, { asset: this.rules.baseAsset, amount: fee })
  }

  async marketSell(_symbol: string, quantity: Decimal, clientOrderId: string): Promise<OrderResult> {
    this.maybeFail('order')
    const proceeds = quantity.mul(this.price)
    const fee = proceeds.mul(this.feeRate)
    this.adjust(this.rules.baseAsset, quantity.neg())
    this.adjust(this.rules.quoteAsset, proceeds.minus(fee))
    return this.record('SELL', clientOrderId, quantity, proceeds, { asset: this.rules.quoteAsset, amount: fee })
  }

  private record(side: 'BUY' | 'SELL', clientOrderId: string, qty: Decimal, quote: Decimal, fee: Commission): OrderResult {
    const result: OrderResult = {
      orderId: String(this.nextOrderId++),
      clientOrderId,
      status: 'FILLED',
      executedQty: qty,
      quoteQty: quote,
      commissions: [fee]
    }
    this.orders.push({ side, clientOrderId, result })
    return result
  }

  private adjust(asset: string, delta: Decimal): void {
    const b = this.balances[asset] ?? { free: new Decimal(0), locked: new Decimal(0) }
    const free = b.free.plus(delta)
    if (free.lt(0)) throw new ExchangeError(`模拟交易所：${asset} 余额不足`, 400, -2010)
    this.balances[asset] = { ...b, free }
  }

  private maybeFail(op: keyof MockExchange['failOn']): void {
    const err = this.failOn[op]
    if (err) {
      this.failOn = { ...this.failOn, [op]: undefined }
      throw err
    }
  }
}
