/**
 * 账本和模拟撮合。
 *
 * 每个模型在每个赛季有一个独立的账本（USDT + 币），从赛季的初始资金开始。
 * 成交由本地模拟：所有模型都按本轮行情快照的价格成交，手续费 0.1%，买卖都以 USDT 收取。
 * 这样不同模型之间唯一的差别就是决策本身，不会因为谁的 LLM 回得慢就成交在不同的价格上。
 * 交易所的数量步长、最小数量、最小下单额照样遵守。
 *
 * 所有金额用 decimal.js 计算，避免 0.1 + 0.2 ≠ 0.3 这类浮点误差。
 */
import Decimal from 'decimal.js'
import { floorToStep, type SymbolRules } from './market'

/** 模拟撮合的手续费率（0.1%，和 Binance 现货默认费率一致） */
export const FEE_RATE = new Decimal('0.001')

export interface Ledger {
  usdt: Decimal
  base: Decimal
}

/** 当前持仓的成本信息，用于计算止损线和已实现盈亏。空仓时不存在。 */
export interface Position {
  /** 这笔持仓花了多少 USDT（含买入手续费）；部分卖出时按比例减少。持仓均价 = cost ÷ 账本持币 */
  cost: Decimal
  /** 持仓以来的最高价（移动止损用） */
  peak: Decimal
}

export interface Fill {
  qty: Decimal
  /** 成交金额，不含手续费 */
  quote: Decimal
  /** 手续费（USDT） */
  fee: Decimal
}

/** 账本资产总值（USDT 计） */
export const equityOf = (ledger: Ledger, price: Decimal) => ledger.usdt.plus(ledger.base.mul(price))

/** 持币市值达到交易所最小下单额才算持仓；卖出后剩下的、卖不掉的零头不算 */
export const isPosition = (base: Decimal, price: Decimal, rules: SymbolRules) =>
  base.mul(price).gte(Decimal.max(rules.minNotional, '0.00000001'))

/**
 * 模拟成交。买入：amount 是愿意花的 USDT（含手续费），按步长取整后算出数量；
 * 卖出：amount 是卖出数量（已按步长取整）。成交额低于最小下单额或数量低于最小数量时返回 null（交易所会拒单）。
 */
export function paperFill(side: 'buy' | 'sell', amount: Decimal, price: Decimal, rules: SymbolRules): Fill | null {
  const qty = side === 'buy'
    ? floorToStep(amount.div(price.mul(FEE_RATE.plus(1))), rules.stepSize)
    : amount
  const quote = qty.mul(price)
  if (qty.lte(0) || qty.lt(rules.minQty) || quote.lt(rules.minNotional)) return null
  return { qty, quote, fee: quote.mul(FEE_RATE) }
}

/** 成交后更新账本：买入扣掉成交额和手续费、加币；卖出减币、加上成交额减去手续费。 */
export function applyFill(ledger: Ledger, side: 'buy' | 'sell', fill: Fill): Ledger {
  if (side === 'buy') return { usdt: ledger.usdt.minus(fill.quote).minus(fill.fee), base: ledger.base.plus(fill.qty) }
  return { usdt: ledger.usdt.plus(fill.quote).minus(fill.fee), base: ledger.base.minus(fill.qty) }
}

/**
 * 成交后更新持仓成本：买入累加花掉的 USDT（含手续费），卖出按卖掉的比例减少成本；卖完（只剩零头）就清空。
 * 卖出时同时算出这部分的已实现盈亏 = 到手的 USDT − 这部分的成本。
 */
export function updatePosition(
  pos: Position | null,
  side: 'buy' | 'sell',
  fill: Fill,
  before: Ledger,
  after: Ledger,
  price: Decimal,
  rules: SymbolRules
): { position: Position | null, realizedPnl: Decimal | null } {
  if (side === 'buy') {
    const spent = fill.quote.plus(fill.fee)
    const position = pos ? { cost: pos.cost.plus(spent), peak: Decimal.max(pos.peak, price) } : { cost: spent, peak: price }
    return { position: isPosition(after.base, price, rules) ? position : null, realizedPnl: null }
  }
  if (!pos || before.base.lte(0)) return { position: null, realizedPnl: null }
  const remaining = pos.cost.mul(after.base).div(before.base)
  const realizedPnl = fill.quote.minus(fill.fee).minus(pos.cost.minus(remaining))
  const position = isPosition(after.base, price, rules) ? { cost: remaining, peak: pos.peak } : null
  return { position, realizedPnl }
}
