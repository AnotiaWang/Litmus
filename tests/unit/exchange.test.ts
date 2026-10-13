import Decimal from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import { BinanceClient, buildQuery, ExchangeError, floorToStep, RateLimitError, sign } from '../../server/lib/exchange'

describe('签名', () => {
  // Binance 官方文档 “SIGNED Endpoint Examples for POST /api/v3/order” 中的示例
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j'

  it('ASCII 参数与文档结果一致', () => {
    const query = buildQuery({ symbol: 'LTCBTC', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: 1, price: '0.1', recvWindow: 5000, timestamp: 1499827319559 })
    expect(query).toBe('symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559')
    expect(sign(query, secret)).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71')
  })

  it('非 ASCII 参数先百分号编码再签名', () => {
    const query = buildQuery({ symbol: '１２３４５６', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: 1, price: '0.1', recvWindow: 5000, timestamp: 1499827319559 })
    expect(query.startsWith('symbol=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96&')).toBe(true)
    expect(sign(query, secret)).toBe('e1353ec6b14d888f1164ae9af8228a3dbd508bc82eb867db8ab6046442f33ef3')
  })
})

it('数量按步长向下取整', () => {
  expect(floorToStep(new Decimal('0.123456'), new Decimal('0.00001')).toFixed()).toBe('0.12345')
  expect(floorToStep(new Decimal('5'), new Decimal('0')).toFixed()).toBe('5')
})

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function client(handler: Handler) {
  const calls: Array<{ url: URL, init: RequestInit }> = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  }) as unknown as typeof fetch
  const c = new BinanceClient({ baseUrl: 'https://demo-api.binance.com', apiKey: 'my-api-key', apiSecret: 'my-secret', fetch: fetchFn, sleep: async () => {} })
  return { c, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const serverTime = (url: URL) => url.pathname === '/api/v3/time' ? json({ serverTime: Date.now() }) : null

describe('BinanceClient', () => {
  it('签名请求带上 Key 头、recvWindow、timestamp 和 signature', async () => {
    const { c, calls } = client(url => serverTime(url) ?? json({ balances: [{ asset: 'USDT', free: '100.5', locked: '0' }] }))
    const balances = await c.getBalances()
    expect(balances.USDT!.free.toFixed()).toBe('100.5')
    const req = calls.find(x => x.url.pathname === '/api/v3/account')!
    expect((req.init.headers as Record<string, string>)['X-MBX-APIKEY']).toBe('my-api-key')
    expect(req.url.searchParams.get('recvWindow')).toBe('5000')
    expect(req.url.searchParams.get('timestamp')).toMatch(/^\d+$/)
    const unsigned = req.url.search.slice(1).replace(/&signature=.*$/, '')
    expect(req.url.searchParams.get('signature')).toBe(sign(unsigned, 'my-secret'))
    // Secret 本身不出现在请求里
    expect(req.url.toString()).not.toContain('my-secret')
  })

  it('网络错误重试 3 次后成功', async () => {
    let n = 0
    const { c } = client(() => {
      if (++n < 4) throw new TypeError('fetch failed')
      return json({ price: '60000.1' })
    })
    expect((await c.getPrice('BTCUSDT')).toFixed()).toBe('60000.1')
    expect(n).toBe(4)
  })

  it('重试 3 次仍失败则抛错', async () => {
    let n = 0
    const { c } = client(() => {
      n++
      throw new TypeError('fetch failed')
    })
    await expect(c.getPrice('BTCUSDT')).rejects.toThrow(/网络错误/)
    expect(n).toBe(4)
  })

  it('429 / 418 直接结束，不重试', async () => {
    for (const status of [429, 418]) {
      let n = 0
      const { c } = client(() => {
        n++
        return json({ code: -1003, msg: 'Too many requests' }, status)
      })
      await expect(c.getPrice('BTCUSDT')).rejects.toBeInstanceOf(RateLimitError)
      expect(n).toBe(1)
    }
  })

  it('4xx 业务错误不重试，带上交易所的错误码', async () => {
    const { c, calls } = client(url => serverTime(url) ?? json({ code: -2010, msg: 'Account has insufficient balance' }, 400))
    const err = await c.marketBuy('BTCUSDT', new Decimal(10), 'abc').catch(e => e)
    expect(err).toBeInstanceOf(ExchangeError)
    expect((err as ExchangeError).code).toBe(-2010)
    expect(calls.filter(x => x.url.pathname === '/api/v3/order')).toHaveLength(1)
  })

  it('下单网络出错后先按 clientOrderId 查询，已成交就不再重复下单', async () => {
    const { c, calls } = client((url, init) => {
      const t = serverTime(url)
      if (t) return t
      if (url.pathname === '/api/v3/order' && init.method === 'POST') throw new TypeError('socket hang up')
      if (url.pathname === '/api/v3/order') {
        return json({ orderId: 7, clientOrderId: url.searchParams.get('origClientOrderId'), status: 'FILLED', executedQty: '0.001', cummulativeQuoteQty: '60' })
      }
      if (url.pathname === '/api/v3/myTrades') return json([{ commission: '0.000001', commissionAsset: 'BTC' }])
      throw new Error(`unexpected ${url.pathname}`)
    })
    const order = await c.marketBuy('BTCUSDT', new Decimal(60), 'decision-1')
    expect(order).toMatchObject({ orderId: '7', clientOrderId: 'decision-1', status: 'FILLED' })
    expect(order.commissions[0]!.amount.toFixed()).toBe('0.000001')
    expect(calls.filter(x => x.url.pathname === '/api/v3/order' && x.init.method === 'POST')).toHaveLength(1)
  })

  it('查询不到订单（-2013）时才重新提交，并使用同一个 clientOrderId', async () => {
    let posts = 0
    const { c, calls } = client((url, init) => {
      const t = serverTime(url)
      if (t) return t
      if (url.pathname === '/api/v3/order' && init.method === 'POST') {
        if (++posts === 1) throw new TypeError('socket hang up')
        return json({ orderId: 8, clientOrderId: url.searchParams.get('newClientOrderId'), status: 'FILLED', executedQty: '0.001', cummulativeQuoteQty: '60', fills: [] })
      }
      return json({ code: -2013, msg: 'Order does not exist.' }, 400)
    })
    const order = await c.marketBuy('BTCUSDT', new Decimal(60), 'decision-2')
    expect(order.orderId).toBe('8')
    const ids = calls.filter(x => x.init.method === 'POST').map(x => x.url.searchParams.get('newClientOrderId'))
    expect(ids).toEqual(['decision-2', 'decision-2'])
  })

  it('时间戳超出 recvWindow（-1021）时重新校准时间再试一次', async () => {
    let accountCalls = 0
    const { c, calls } = client((url) => {
      const t = serverTime(url)
      if (t) return t
      if (++accountCalls === 1) return json({ code: -1021, msg: 'Timestamp outside recvWindow' }, 400)
      return json({ balances: [] })
    })
    await c.getBalances()
    expect(calls.filter(x => x.url.pathname === '/api/v3/time')).toHaveLength(2)
  })

  it('解析交易对规则（LOT_SIZE、NOTIONAL）', async () => {
    const { c } = client(() => json({
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
    const rules = await c.getSymbolRules('BTCUSDT')
    expect(rules.stepSize.toFixed()).toBe('0.00001')
    expect(rules.minNotional.toFixed()).toBe('5')
  })
})
