/**
 * 行情：从 Binance 的公开行情接口取 K 线、现价和交易对规则。
 *
 * 用的是 data-api.binance.vision——Binance 专门提供的只读行情地址，不需要 API Key，也没有任何交易接口。
 * 成交由本地模拟撮合（见 ledger.ts），程序不会向任何交易所下单。
 * 另外提供一个内存里的模拟实现供测试和回测使用。
 */
import Decimal from 'decimal.js'

export const MARKET_DATA_URL = 'https://data-api.binance.vision'

export interface Kline {
  openTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  closeTime: number
}

/** 交易对规则：数量步长、最小数量、最小下单额（NOTIONAL 过滤器）。模拟撮合也按这些规则来。 */
export interface SymbolRules {
  symbol: string
  baseAsset: string
  quoteAsset: string
  stepSize: Decimal
  minQty: Decimal
  minNotional: Decimal
}

export interface Market {
  getSymbolRules(symbol: string): Promise<SymbolRules>
  /** startTime / endTime 可选，回测时用来分页拉取历史 K 线（每次最多 1000 根）。 */
  getKlines(symbol: string, interval: string, limit: number, range?: { startTime?: number, endTime?: number }): Promise<Kline[]>
  getPrice(symbol: string): Promise<Decimal>
}

export class MarketError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message)
  }
}

/** 数量按步长向下取整，例如 stepSize=0.00001 时 0.123456 → 0.12345。 */
export function floorToStep(qty: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return qty
  return qty.div(step).floor().mul(step)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface BinanceMarketOptions {
  baseUrl?: string
  timeoutMs?: number
  /** 测试时可替换 */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const MAX_RETRIES = 3
/** 交易对规则很少变，缓存一天 */
const RULES_TTL_MS = 24 * 60 * 60 * 1000

export class BinanceMarket implements Market {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private rulesCache = new Map<string, { rules: SymbolRules, at: number }>()

  constructor(opts: BinanceMarketOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? MARKET_DATA_URL).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchFn = opts.fetch ?? fetch
    this.sleepFn = opts.sleep ?? sleep
  }

  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const cached = this.rulesCache.get(symbol)
    if (cached && Date.now() - cached.at < RULES_TTL_MS) return cached.rules
    const data = await this.get('/api/v3/exchangeInfo', { symbol }) as {
      symbols: Array<{ symbol: string, baseAsset: string, quoteAsset: string, filters: Array<Record<string, string>> }>
    }
    const info = data.symbols.find(s => s.symbol === symbol)
    if (!info) throw new MarketError(`交易所没有交易对 ${symbol}`)
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
    this.rulesCache.set(symbol, { rules, at: Date.now() })
    return rules
  }

  async getKlines(symbol: string, interval: string, limit: number, range: { startTime?: number, endTime?: number } = {}): Promise<Kline[]> {
    const params: Record<string, string | number> = { symbol, interval, limit }
    if (range.startTime !== undefined) params.startTime = range.startTime
    if (range.endTime !== undefined) params.endTime = range.endTime
    const rows = await this.get('/api/v3/klines', params) as Array<Array<string | number>>
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
    const data = await this.get('/api/v3/ticker/price', { symbol }) as { price: string }
    return new Decimal(data.price)
  }

  /** 网络错误、超时、5xx 时按指数退避重试，最多 3 次。 */
  private async get(path: string, params: Record<string, string | number>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(path, params)
      } catch (e) {
        if (!(e instanceof MarketError) || !e.retryable || attempt >= MAX_RETRIES) throw e
        await this.sleepFn(500 * 2 ** attempt)
      }
    }
  }

  private async send(path: string, params: Record<string, string | number>): Promise<unknown> {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`
    let res: Response
    try {
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      const name = (e as Error).name
      const reason = name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : `网络错误：${(e as Error).message}`
      throw new MarketError(`行情接口 ${path} ${reason}`, true)
    }
    const text = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw new MarketError(`行情接口 ${path} 返回的不是 JSON`)
      }
    }
    let msg = text.slice(0, 200)
    try {
      msg = (JSON.parse(text) as { msg?: string }).msg ?? msg
    } catch {
      // 不是 JSON 就用原文
    }
    // 429 / 418：请求过多或 IP 被临时封禁，本轮直接结束，不重试
    throw new MarketError(`行情接口 ${path} 失败（HTTP ${res.status}）：${msg}`, res.status >= 500)
  }
}

/** 模拟行情：全部在内存里，测试里直接修改公开字段来构造各种场景。 */
export class MockMarket implements Market {
  klines: Kline[] = []
  price = new Decimal('50000')
  rules: SymbolRules = {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    stepSize: new Decimal('0.00001'),
    minQty: new Decimal('0.00001'),
    minNotional: new Decimal('5')
  }

  /** 按周期单独指定的 K 线（如 1d），没指定的周期都返回 klines */
  intervalKlines: Partial<Record<string, Kline[]>> = {}

  /** 设置后，下一次调用对应方法会抛出这个错误 */
  failOn: Partial<Record<'getKlines' | 'getPrice', Error>> = {}

  async getSymbolRules(): Promise<SymbolRules> {
    return this.rules
  }

  async getKlines(_symbol: string, interval: string, limit: number): Promise<Kline[]> {
    this.maybeFail('getKlines')
    return (this.intervalKlines[interval] ?? this.klines).slice(-limit)
  }

  async getPrice(): Promise<Decimal> {
    this.maybeFail('getPrice')
    return this.price
  }

  private maybeFail(op: keyof MockMarket['failOn']): void {
    const err = this.failOn[op]
    if (err) {
      this.failOn = { ...this.failOn, [op]: undefined }
      throw err
    }
  }
}
