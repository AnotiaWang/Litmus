/** 风控规则的中文名称。后端拼拦截原因、前端显示风控列都用这一份。 */
export type RiskRule
  = | 'daily_loss'
    | 'max_trades'
    | 'cooldown'
    | 'no_funds'
    | 'max_position'
    | 'no_position'
    | 'min_notional'

export const RISK_RULE_LABELS: Record<RiskRule, string> = {
  daily_loss: '当日亏损熔断',
  max_trades: '每日交易次数',
  cooldown: '交易冷却时间',
  no_funds: '账本没有可用 USDT',
  max_position: '仓位上限',
  no_position: '只卖已有持仓',
  min_notional: '最小下单额'
}
