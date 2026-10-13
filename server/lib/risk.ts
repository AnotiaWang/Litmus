/**
 * 风控：下单之前的最后一道关。
 *
 * 纯函数，不访问网络和数据库：输入当前账本、限额和历史统计，输出“放行（及最终金额 / 数量）”或“拦截（及原因）”。
 * 风控只会把金额调小，永远不会调大；任何一条不通过就不下单，并记录是哪一条。
 *
 * 分两步：
 * - precheck：不需要知道金额就能判断的规则（熔断、次数、冷却、有没有钱 / 仓位空间），在调用 LLM 之前执行，
 *   注定下不了单时就不浪费一次 LLM 调用
 * - evaluateRisk：拿到 LLM 建议的比例后，先再跑一遍 precheck，再算出最终金额 / 数量
 *
 * 卖出是降低风险的操作（包括止损），不受熔断、每日次数、冷却时间和单笔上限约束，只检查有没有可卖的币和最小下单额。
 * 所有金额用 decimal.js 计算，避免 0.1 + 0.2 ≠ 0.3 这类浮点误差。
 */
import Decimal from 'decimal.js'
import type { Config } from './config'
import { RISK_RULE_LABELS, type RiskRule } from '../../shared/risk-rules'
import { floorToStep, type SymbolRules } from './exchange'

export { RISK_RULE_LABELS, type RiskRule }

export interface PrecheckInput {
  side: 'buy' | 'sell'
  price: Decimal
  ledger: { usdt: Decimal, base: Decimal }
  /** 可卖数量 = min(账本持币, 账户真实可用余额) */
  sellableBase: Decimal
  rules: SymbolRules
  limits: Config['risk']
  /** 今天（UTC）已成交笔数 */
  tradesToday: number
  lastTradeAt: Date | null
  now: Date
  /** UTC 0 点的账本资产快照；还没有快照时为 null */
  dayStartEquity: Decimal | null
  equity: Decimal
}

export interface RiskInput extends PrecheckInput {
  /** 买入：动用账本可用 USDT 的比例（0~100），LLM 关闭时传 100。卖出：卖掉持币的比例，规则模式固定 100，LLM 决策模式由 LLM 给出 */
  sizePct: number
}

export interface RiskResult {
  passed: boolean
  rule?: RiskRule
  /** 拦截原因，或放行时金额被调整的说明 */
  reason: string
  /** 买入金额（USDT） */
  quoteAmount?: Decimal
  /** 卖出数量（币） */
  quantity?: Decimal
}

const block = (rule: RiskRule, reason: string): RiskResult => ({ passed: false, rule, reason: `${RISK_RULE_LABELS[rule]}：${reason}` })

/** 当日亏损百分比（亏损为正数）。没有 0 点快照时视为 0。 */
export function dailyLossPct(dayStartEquity: Decimal | null, equity: Decimal): Decimal {
  if (!dayStartEquity || dayStartEquity.lte(0)) return new Decimal(0)
  return dayStartEquity.minus(equity).div(dayStartEquity).mul(100)
}

/** 不需要金额就能判断的规则。返回 null 表示通过。 */
export function precheck(input: PrecheckInput): RiskResult | null {
  const { limits, ledger, rules } = input

  if (input.side === 'sell') {
    if (ledger.base.lte(0) || input.sellableBase.lte(0)) return block('no_position', '账本没有持币')
    return null
  }

  const loss = dailyLossPct(input.dayStartEquity, input.equity)
  if (loss.gte(limits.dailyLossLimitPct)) {
    return block('daily_loss', `今日已亏损 ${loss.toFixed(2)}%，达到 ${limits.dailyLossLimitPct}% 上限`)
  }
  if (input.tradesToday >= limits.maxTradesPerDay) {
    return block('max_trades', `今天已成交 ${input.tradesToday} 笔，达到每日 ${limits.maxTradesPerDay} 笔上限`)
  }
  if (input.lastTradeAt) {
    const minutes = (input.now.getTime() - input.lastTradeAt.getTime()) / 60_000
    if (minutes < limits.cooldownMinutes) {
      return block('cooldown', `距上一笔成交仅 ${Math.floor(minutes)} 分钟，需间隔 ${limits.cooldownMinutes} 分钟`)
    }
  }
  if (ledger.usdt.lt(rules.minNotional) || ledger.usdt.lte(0)) {
    return block('no_funds', `账本可用 ${ledger.usdt.toFixed(2)} USDT，低于交易所最小下单额 ${rules.minNotional.toFixed()}`)
  }
  const { positionValue, room } = positionRoom(input)
  if (room.lt(rules.minNotional) || room.lte(0)) {
    return block('max_position', `持币市值 ${positionValue.toFixed(2)} 已接近总资产的 ${limits.maxPositionPct}%，剩余空间不足最小下单额`)
  }
  return null
}

/** 买入后持币市值不能超过账本总资产的 maxPositionPct%，返回还能买多少 USDT。 */
function positionRoom({ ledger, price, limits }: PrecheckInput) {
  const positionValue = ledger.base.mul(price)
  const total = ledger.usdt.plus(positionValue)
  return { positionValue, room: total.mul(limits.maxPositionPct).div(100).minus(positionValue) }
}

export function evaluateRisk(input: RiskInput): RiskResult {
  const { limits, ledger, rules } = input

  const pre = precheck(input)
  if (pre) return pre

  const notes: string[] = []

  if (input.side === 'buy') {
    const suggested = ledger.usdt.mul(input.sizePct).div(100)
    let amount = suggested
    if (amount.gt(limits.maxOrderUsdt)) {
      amount = limits.maxOrderUsdt
      notes.push(`按单笔上限调小到 ${amount.toFixed(2)}`)
    }
    if (amount.gt(ledger.usdt)) {
      amount = ledger.usdt
      notes.push(`按账本可用 USDT 调小到 ${amount.toFixed(2)}`)
    }
    const { room } = positionRoom(input)
    if (amount.gt(room)) {
      amount = room
      notes.push(`按仓位上限调小到 ${amount.toFixed(2)}`)
    }
    // USDT 金额保留两位小数，向下取整
    amount = amount.toDecimalPlaces(2, Decimal.ROUND_DOWN)
    if (amount.lt(rules.minNotional) || amount.lte(0)) {
      return block('min_notional', `金额 ${amount.toFixed(2)} USDT 低于交易所最小下单额 ${rules.minNotional.toFixed()}（LLM 建议 ${suggested.toFixed(2)}）`)
    }
    return { passed: true, reason: notes.length ? notes.join('；') : '未调整', quoteAmount: amount }
  }

  // 卖出：不做空，只能卖账本里已有、且账户里确实可用的币（是否有币已在 precheck 检查过）
  let qty = ledger.base.mul(input.sizePct).div(100)
  // 只卖一部分时，剩下的如果不够最小下单额就再也卖不掉了，干脆全部卖出
  if (input.sizePct < 100 && ledger.base.minus(qty).mul(input.price).lt(rules.minNotional)) {
    qty = ledger.base
    notes.push('剩余部分不足最小下单额，改为全部卖出')
  }
  if (qty.gt(input.sellableBase)) {
    qty = input.sellableBase
    notes.push(`按可用余额调小到 ${qty.toFixed()}`)
  }
  qty = floorToStep(qty, rules.stepSize)
  if (qty.lt(rules.minQty) || qty.lte(0)) {
    return block('min_notional', `卖出数量 ${qty.toFixed()} 低于最小数量 ${rules.minQty.toFixed()}`)
  }
  const notional = qty.mul(input.price)
  if (notional.lt(rules.minNotional)) {
    return block('min_notional', `卖出金额约 ${notional.toFixed(2)} USDT 低于交易所最小下单额 ${rules.minNotional.toFixed()}`)
  }
  return { passed: true, reason: notes.length ? notes.join('；') : '未调整', quantity: qty }
}
