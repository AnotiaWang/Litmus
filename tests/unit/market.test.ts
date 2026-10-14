import Decimal from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import { applyFill, FEE_RATE, paperFill, updatePosition, type Ledger } from '../../server/lib/ledger'
import { BinanceMarket, floorToStep, MarketError, MARKET_DATA_URL, type SymbolRules } from '../../server/lib/market'

it('数量按步长向下取整', () => {
  expect(floorToStep(new Decimal('0.123456'), new Decimal('0.00001')).toFixed()).toBe('0.12345')
  expect(floorToStep(new Decimal('5'), new Decimal('0')).toFixed()).toBe('5')
})

type Handler = (url: URL) => Response | Promise<Response>

function market(handler: Handler) {
  const calls: URL[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url)
    // 公开行情接口不带任何认证信息
    expect(init?.headers).toBeUndefined()
    return handler(url)
  }) as unknown as typeof fetch
  return { m: new BinanceMarket({ fetch: fetchFn, sleep: async () => {} }), calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('行情接口', () => {
  it('默认用 Binance 的只读行情地址', async () => {
    const { m, calls } = market(() => json({ symbol: 'BTCUSDT', price: '83382.01000000' }))
    expect((await m.getPrice('BTCUSDT')).toFixed()).toBe('83382.01')
    expect(MARKET_DATA_URL).toBe('https://data-api.binance.vision')
    expect(calls[0]!.toString()).toBe('https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT')
  })

  it('解析 K 线；可以按时间范围分页', async () => {
    const { m, calls } = market(() => json([[1000, '1.5', '2', '1', '1.8', '10.5', 1999, '0', 1, '0', '0', '0']]))
    const klines = await m.getKlines('BTCUSDT', '1h', 2, { startTime: 1000, endTime: 5000 })
    expect(klines).toEqual([{ openTime: 1000, open: '1.5', high: '2', low: '1', close: '1.8', volume: '10.5', closeTime: 1999 }])
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ symbol: 'BTCUSDT', interval: '1h', limit: '2', startTime: '1000', endTime: '5000' })
  })

  it('网络错误重试 3 次后成功', async () => {
    let n = 0
    const { m } = market(() => {
      if (++n <= 3) throw new TypeError('fetch failed')
      return json({ price: '1' })
    })
    expect((await m.getPrice('BTCUSDT')).toFixed()).toBe('1')
    expect(n).toBe(4)
  })

  it('重试 3 次仍失败则抛错', async () => {
    let n = 0
    const { m } = market(() => {
      n++
      return new Response('oops', { status: 502 })
    })
    await expect(m.getPrice('BTCUSDT')).rejects.toThrow(MarketError)
    expect(n).toBe(4)
  })

  it('429 / 4xx 不重试，带上接口返回的错误信息', async () => {
    let n = 0
    const { m } = market(() => {
      n++
      return json({ code: -1003, msg: 'Too many requests' }, 429)
    })
    await expect(m.getPrice('BTCUSDT')).rejects.toThrow('HTTP 429）：Too many requests')
    expect(n).toBe(1)
  })

  it('解析交易对规则（LOT_SIZE、NOTIONAL），并缓存', async () => {
    const { m, calls } = market(() => json({
      symbols: [{
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
          { filterType: 'LOT_SIZE', minQty: '0.00001', maxQty: '9000', stepSize: '0.00001' },
          { filterType: 'NOTIONAL', minNotional: '5.00000000', applyMinToMarket: true }
        ]
      }]
    }))
    const rules = await m.getSymbolRules('BTCUSDT')
    expect(rules.stepSize.toFixed()).toBe('0.00001')
    expect(rules.minNotional.toFixed()).toBe('5')
    await m.getSymbolRules('BTCUSDT')
    expect(calls).toHaveLength(1)
  })

  it('没有这个交易对时报错', async () => {
    const { m } = market(() => json({ symbols: [] }))
    await expect(m.getSymbolRules('XXXUSDT')).rejects.toThrow('交易所没有交易对 XXXUSDT')
  })
})

describe('模拟撮合', () => {
  const rules: SymbolRules = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', stepSize: new Decimal('0.00001'), minQty: new Decimal('0.00001'), minNotional: new Decimal('5') }
  const price = new Decimal(50000)

  it('买入：花的钱（含手续费）不超过给定金额，数量按步长取整，手续费 0.1% 以 USDT 收取', () => {
    const fill = paperFill('buy', new Decimal(40), price, rules)!
    // 40 / (50000 × 1.001) = 0.000799… → 0.00079
    expect(fill.qty.toFixed()).toBe('0.00079')
    expect(fill.quote.toFixed()).toBe('39.5')
    expect(fill.fee.toFixed()).toBe('0.0395')
    expect(fill.quote.plus(fill.fee).lte(40)).toBe(true)
    expect(FEE_RATE.toFixed()).toBe('0.001')
  })

  it('卖出：按给定数量成交，到手金额扣除手续费', () => {
    const fill = paperFill('sell', new Decimal('0.001'), price, rules)!
    expect(fill).toMatchObject({ qty: new Decimal('0.001'), quote: new Decimal(50), fee: new Decimal('0.05') })
  })

  it('成交额低于最小下单额时不成交', () => {
    expect(paperFill('buy', new Decimal('5'), price, rules)).toBeNull()
    expect(paperFill('sell', new Decimal('0.00009'), price, rules)).toBeNull()
  })

  it('账本和持仓成本：买入累加成本，卖出按比例减少并算出已实现盈亏', () => {
    const start: Ledger = { usdt: new Decimal(100), base: new Decimal(0) }
    const buy = paperFill('buy', new Decimal(40), price, rules)!
    const afterBuy = applyFill(start, 'buy', buy)
    expect(afterBuy).toEqual({ usdt: new Decimal('60.4605'), base: new Decimal('0.00079') })
    const opened = updatePosition(null, 'buy', buy, start, afterBuy, price, rules)
    expect(opened).toEqual({ position: { cost: new Decimal('39.5395'), peak: price }, realizedPnl: null })

    // 涨到 60000 卖出一半以上：0.0004 BTC
    const higher = new Decimal(60000)
    const sell = paperFill('sell', new Decimal('0.0004'), higher, rules)!
    const afterSell = applyFill(afterBuy, 'sell', sell)
    expect(afterSell.base.toFixed()).toBe('0.00039')
    const closedPart = updatePosition(opened.position, 'sell', sell, afterBuy, afterSell, higher, rules)
    // 剩下 0.00039 / 0.00079 的成本
    expect(closedPart.position!.cost.toFixed()).toBe(new Decimal('39.5395').mul('0.00039').div('0.00079').toFixed())
    // 到手 24 − 0.024，减去卖掉部分的成本
    expect(closedPart.realizedPnl!.toFixed()).toBe(new Decimal('23.976').minus(new Decimal('39.5395').minus(closedPart.position!.cost)).toFixed())
    expect(closedPart.realizedPnl!.gt(0)).toBe(true)
  })

  it('卖到只剩零头时清空持仓', () => {
    const before: Ledger = { usdt: new Decimal(0), base: new Decimal('0.00101') }
    const sell = paperFill('sell', new Decimal('0.001'), price, rules)!
    const after = applyFill(before, 'sell', sell)
    expect(updatePosition({ cost: new Decimal(51), peak: price }, 'sell', sell, before, after, price, rules).position).toBeNull()
  })
})
