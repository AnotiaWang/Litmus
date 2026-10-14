import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import type { SymbolRules } from '../../server/lib/market'
import { evaluateRisk, maxOrderUsdt, precheck, type RiskInput } from '../../server/lib/risk'
import { FIXTURE_RISK } from './helpers'

const rules: SymbolRules = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  stepSize: new Decimal('0.00001'),
  minQty: new Decimal('0.00001'),
  minNotional: new Decimal('5')
}
const now = new Date('2026-10-08T12:00:00Z')

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    side: 'buy',
    sizePct: 100,
    price: new Decimal(50000),
    ledger: { usdt: new Decimal(100), base: new Decimal(0) },
    rules,
    limits: FIXTURE_RISK,
    tradesToday: 0,
    lastTradeAt: null,
    now,
    dayStartEquity: new Decimal(100),
    equity: new Decimal(100),
    ...overrides
  }
}

describe('风控 · 买入', () => {
  it('最终金额 = min(LLM 建议, 单笔上限, 账本可用)', () => {
    expect(evaluateRisk(input({ sizePct: 30 })).quoteAmount!.toFixed()).toBe('30')
    const capped = evaluateRisk(input({ sizePct: 100 }))
    // 100 → 单笔上限：总资产 100 的 50%
    expect(capped.quoteAmount!.toFixed()).toBe('50')
    expect(capped.reason).toContain('单笔上限（总资产的 50%）')
  })

  it('单笔上限按总资产（现金 + 持币市值）的百分比计算', () => {
    const limits = { ...FIXTURE_RISK, maxOrderPct: 20, maxPositionPct: 100 }
    // 现金 60 + 持币 0.0008 × 50000 = 40，总资产 100 → 单笔最多 20
    expect(maxOrderUsdt({ ledger: { usdt: new Decimal(60), base: new Decimal('0.0008') }, price: new Decimal(50000), limits }).toFixed()).toBe('20')
    expect(evaluateRisk(input({ limits, ledger: { usdt: new Decimal(60), base: new Decimal('0.0008') } })).quoteAmount!.toFixed()).toBe('20')
  })

  it('仓位上限：买入后持币市值不超过总资产的 50%，超出部分调小', () => {
    // 持币 40 USDT + 现金 60 = 100，上限 50 → 最多再买 10
    const r = evaluateRisk(input({ ledger: { usdt: new Decimal(60), base: new Decimal('0.0008') } }))
    expect(r.passed).toBe(true)
    expect(r.quoteAmount!.toFixed()).toBe('10')
    expect(r.reason).toContain('仓位上限')
  })

  it('仓位已满时拦截', () => {
    const r = evaluateRisk(input({ ledger: { usdt: new Decimal(50), base: new Decimal('0.001') } }))
    expect(r).toMatchObject({ passed: false, rule: 'max_position' })
  })

  it('低于最小下单额时拦截', () => {
    expect(evaluateRisk(input({ sizePct: 4 }))).toMatchObject({ passed: false, rule: 'min_notional' })
  })

  it('风控只会调小，不会调大', () => {
    for (const sizePct of [6, 10, 25, 49.99, 50, 80, 100]) {
      const r = evaluateRisk(input({ sizePct }))
      expect(r.quoteAmount!.lte(new Decimal(100).mul(sizePct).div(100))).toBe(true)
    }
  })
})

describe('风控 · 卖出', () => {
  const holding = { ledger: { usdt: new Decimal(50), base: new Decimal('0.00123') }, side: 'sell' as const }

  it('卖出数量按比例并按步长向下取整', () => {
    const r = evaluateRisk(input({ ...holding, sizePct: 50 }))
    expect(r.quantity!.toFixed()).toBe('0.00061')
  })

  it('只卖已有持仓', () => {
    expect(evaluateRisk(input({ side: 'sell' }))).toMatchObject({ passed: false, rule: 'no_position' })
  })

  it('部分卖出后剩下的不够最小下单额时，改为全部卖出', () => {
    // 0.00123 × 90% 卖完剩 0.000123 BTC ≈ 6.15 USDT 够卖；95% 剩 ≈ 3.08 USDT 不够
    expect(evaluateRisk(input({ ...holding, sizePct: 90 })).quantity!.toFixed()).toBe('0.0011')
    const r = evaluateRisk(input({ ...holding, sizePct: 95 }))
    expect(r.quantity!.toFixed()).toBe('0.00123')
    expect(r.reason).toContain('改为全部卖出')
  })

  it('卖出金额低于最小下单额时拦截', () => {
    expect(evaluateRisk(input({ ...holding, sizePct: 5 }))).toMatchObject({ passed: false, rule: 'min_notional' })
  })
})

describe('风控 · 通用规则', () => {
  it('每日交易次数', () => {
    expect(evaluateRisk(input({ tradesToday: 6 }))).toMatchObject({ passed: false, rule: 'max_trades' })
    expect(evaluateRisk(input({ tradesToday: 5 })).passed).toBe(true)
  })

  it('交易冷却时间', () => {
    expect(evaluateRisk(input({ lastTradeAt: new Date(now.getTime() - 59 * 60_000) }))).toMatchObject({ passed: false, rule: 'cooldown' })
    expect(evaluateRisk(input({ lastTradeAt: new Date(now.getTime() - 60 * 60_000) })).passed).toBe(true)
  })

  it('当日亏损熔断', () => {
    expect(evaluateRisk(input({ equity: new Decimal(95) }))).toMatchObject({ passed: false, rule: 'daily_loss' })
    expect(evaluateRisk(input({ equity: new Decimal('95.01') })).passed).toBe(true)
  })

  it('熔断中（到下一个 UTC 0 点）：即使资产已经回升也不买入', () => {
    const r = evaluateRisk(input({ circuit: '今日已亏损 6.00%（上限 5%）' }))
    expect(r).toMatchObject({ passed: false, rule: 'daily_loss' })
    expect(r.reason).toBe('当日亏损熔断：今日已亏损 6.00%（上限 5%）')
  })

  it('卖出不受熔断、每日次数、冷却时间约束', () => {
    const sell = { side: 'sell' as const, ledger: { usdt: new Decimal(50), base: new Decimal('0.001') } }
    const r = evaluateRisk(input({ ...sell, equity: new Decimal(90), circuit: '熔断中', tradesToday: 99, lastTradeAt: new Date(now.getTime() - 60_000) }))
    expect(r.passed).toBe(true)
    expect(r.quantity!.toFixed()).toBe('0.001')
  })
})

describe('风控预检（调用 LLM 之前）', () => {
  it('不需要金额的规则在预检里就能拦下', () => {
    expect(precheck(input({ tradesToday: 6 }))).toMatchObject({ passed: false, rule: 'max_trades' })
    expect(precheck(input({ lastTradeAt: now }))).toMatchObject({ passed: false, rule: 'cooldown' })
    expect(precheck(input({ equity: new Decimal(90) }))).toMatchObject({ passed: false, rule: 'daily_loss' })
    expect(precheck(input({ side: 'sell' }))).toMatchObject({ passed: false, rule: 'no_position' })
  })

  it('账本 USDT 不够最小下单额、或仓位空间不够时拦下', () => {
    expect(precheck(input({ ledger: { usdt: new Decimal(4), base: new Decimal(0) } }))).toMatchObject({ rule: 'no_funds' })
    // 持币 48 USDT + 现金 52，上限 50%，只剩 2 USDT 空间
    expect(precheck(input({ ledger: { usdt: new Decimal(52), base: new Decimal('0.00096') } }))).toMatchObject({ rule: 'max_position' })
  })

  it('都通过时返回 null', () => {
    expect(precheck(input())).toBeNull()
  })
})
