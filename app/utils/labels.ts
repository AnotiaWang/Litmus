/** 页面上各种状态的中文名称、颜色和术语解释，各组件共用这一份。 */
import type { LlmStatus, Outcome } from '#shared/types/api'
import { RISK_PRESET_LABELS, type RiskParams, type RiskPreset } from '#shared/settings'

export type BadgeColor = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary'

type Action = 'buy' | 'sell' | 'hold'

export const ACTIONS: Record<Action, { label: string, color: BadgeColor, className: string }> = {
  buy: { label: '买入', color: 'success', className: 'text-success' },
  sell: { label: '卖出', color: 'error', className: 'text-error' },
  hold: { label: '观望', color: 'neutral', className: 'text-muted' }
}

/** 动作的简短文字，如“买入 40%”“卖出 100%”“观望” */
export function actionText(action: Action, sizePct: number | null): string {
  return action === 'hold' || sizePct === null ? ACTIONS[action].label : `${ACTIONS[action].label} ${sizePct}%`
}

export const OUTCOMES: Record<Outcome, { label: string, color: BadgeColor }> = {
  hold: { label: '观望', color: 'neutral' },
  paused: { label: '暂停中', color: 'warning' },
  risk_block: { label: '风控拦截', color: 'warning' },
  filled: { label: '已成交', color: 'success' },
  error: { label: '出错', color: 'error' }
}

export const LLM_STATUS: Record<LlmStatus, { label: string, color: BadgeColor }> = {
  ok: { label: '正常', color: 'success' },
  invalid_output: { label: '输出不合格', color: 'warning' },
  request_failed: { label: '请求失败', color: 'error' }
}

/** 风控参数的中文名称和单位，赛季配置的展示和表单共用 */
export const RISK_FIELDS: Array<{ key: keyof RiskParams, label: string, unit: string, help: string }> = [
  { key: 'stopLossPct', label: '止损', unit: '%', help: '价格比持仓均价低这么多时，程序直接全部卖出；0 为关闭' },
  { key: 'trailingStopPct', label: '移动止损', unit: '%', help: '价格比持仓以来的最高价低这么多时全部卖出；0 为关闭' },
  { key: 'maxOrderPct', label: '单笔上限', unit: '%', help: '单笔买入最多动用总资产的百分之几' },
  { key: 'maxPositionPct', label: '仓位上限', unit: '%', help: '持币市值最多占总资产的百分之几' },
  { key: 'maxTradesPerDay', label: '每日成交', unit: '笔', help: '每天（UTC）最多成交几笔（买卖都算），达到后当天不再买入' },
  { key: 'cooldownMinutes', label: '冷却', unit: '分钟', help: '上一笔成交后至少间隔多久才能再买入；0 为不限制' },
  { key: 'dailyLossLimitPct', label: '当日亏损熔断', unit: '%', help: '当日亏损达到这么多时，当天不再买入（卖出照常）' }
]

export const presetLabel = (p: RiskPreset) => RISK_PRESET_LABELS[p]

/** 风控参数的一行摘要，如“止损 10% · 单笔上限 100% · …”，0 表示关闭的项写“关闭” */
export function riskSummary(risk: RiskParams): string {
  return RISK_FIELDS.map(({ key, label, unit }) => {
    const v = risk[key]
    const off = v === 0 && (key === 'stopLossPct' || key === 'trailingStopPct' || key === 'cooldownMinutes')
    return `${label} ${off ? '关闭' : `${v}${unit === '%' ? '%' : ` ${unit}`}`}`
  }).join(' · ')
}

/** 术语解释，给第一次看的人。 */
export const GLOSSARY = {
  returnPct: '当前资产总值相对初始资金的涨跌。所有模型的初始资金相同，可以直接比较。',
  benchmark: '从赛季（或这个模型）开始时把全部资金一次性买成币、之后什么都不做，到现在的收益率。用来判断模型有没有比“躺平”更好。',
  excess: '收益率减去同期“一直持有”的收益率。为正说明跑赢了躺平，为负说明还不如一直拿着。',
  drawdown: '资产从此前的最高点回落的最大幅度，衡量过程中最难受的时候亏了多少。',
  winRate: '卖出时扣除买卖手续费后仍然赚钱的笔数占卖出笔数的比例。',
  llmOk: 'LLM 作答的次数里，给出合法决策的比例（输出格式不对算失败）。请求失败（超时、网络、HTTP 错误）是服务的问题，不算在内，单独列出。两种失败程序都代为观望；请求失败的那根 K 线之后每轮都会重问。',
  baseline: '不调用 LLM 的对照组：SMA20 连续 2 根 K 线在 SMA50 上方时买入（金额只受风控限制），在下方时全部卖出；RSI14 高于 70 时不追高。止损和其他风控和 LLM 模型相同。用来看 LLM 有没有比简单规则更好。',
  action: 'LLM 模型的动作由 LLM 决定（止损由程序直接执行）；均线基线的动作由规则算出。',
  risk: '成交前的最后一道检查：当日亏损、每日笔数、冷却时间、仓位上限、最小下单额等，只会调小金额或拦下交易。',
  confidence: 'LLM 对这次判断的把握程度，0 到 1，越接近 1 越有把握。',
  paper: '模拟撮合：按每一轮行情快照的价格成交，所有模型用同一个价格，手续费 0.1%，不在交易所真实下单。'
}
