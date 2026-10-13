/** 面板上各种状态的中文名称、颜色和术语解释，各组件共用这一份。 */
import type { Outcome, StatusResponse } from '#shared/types/api'

export type BadgeColor = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary'

export const SIGNALS: Record<'buy' | 'sell' | 'hold', { label: string, color: BadgeColor }> = {
  buy: { label: '买入', color: 'success' },
  sell: { label: '卖出', color: 'error' },
  hold: { label: '观望', color: 'neutral' }
}

/** LLM 结论：规则模式是复核（批准 / 否决），LLM 决策模式是动作。比例另外拼 */
export const LLM_DECISIONS: Record<'approve' | 'reject' | 'buy' | 'sell' | 'hold', { label: string, className: string }> = {
  approve: { label: '批准', className: 'text-success' },
  reject: { label: '否决', className: 'text-warning' },
  buy: { label: '买入', className: 'text-success' },
  sell: { label: '卖出', className: 'text-error' },
  hold: { label: '观望', className: 'text-muted' }
}

/** LLM 结论的简短文字，如“批准 40%”“卖出 50%”“观望” */
export function llmDecisionText(d: { llmDecision: keyof typeof LLM_DECISIONS | null, llmSizePct: number | null }): string {
  if (!d.llmDecision) return '-'
  const pct = d.llmDecision === 'approve' || d.llmDecision === 'buy' || d.llmDecision === 'sell' ? ` ${d.llmSizePct}%` : ''
  return `${LLM_DECISIONS[d.llmDecision].label}${pct}`
}

/** label 用在表格里；toast 是手动运行结束时的提示，没有时用 label */
export const OUTCOMES: Record<Outcome, { label: string, color: BadgeColor, toast?: string }> = {
  running: { label: '运行中', color: 'info' },
  hold: { label: '观望', color: 'neutral' },
  paused: { label: '暂停中', color: 'warning', toast: '暂停中，只记录信号' },
  llm_reject: { label: 'LLM 否决', color: 'warning' },
  risk_block: { label: '风控拦截', color: 'warning' },
  filled: { label: '已成交', color: 'success' },
  unfilled: { label: '未成交', color: 'warning' },
  error: { label: '出错', color: 'error', toast: '出错，详情见决策记录' },
  interrupted: { label: '中断', color: 'error' }
}

/** 术语解释，给新手看。带上实际的策略参数，说得具体一些。 */
export function glossary(strategy?: StatusResponse['strategy']) {
  const k = strategy ? `${strategy.klineInterval} ` : ''
  return {
    signal: '每轮决策的起点（买入 / 卖出 / 观望）。规则模式下由均线和 RSI 按固定规则算出；LLM 决策模式下是大模型给出的动作，止损由程序直接给出。',
    llm: '规则模式下，大模型对买入信号做第二道判断：批准时给出动用资金的比例，否决则本轮不交易。LLM 决策模式下，大模型直接决定买入（动用可用 USDT 的比例）、卖出（卖掉持币的比例）或观望。',
    risk: '下单前的最后一道检查：当日亏损、每日次数、冷却时间、仓位上限、最小下单额等，任何一条不通过就不下单。',
    smaFast: `短期均线（SMA${strategy?.smaFast ?? ''}）：最近 ${strategy?.smaFast ?? 'N'} 根 ${k}K 线收盘价的平均值。短期均线在长期均线上方，通常视为上涨趋势。`,
    smaSlow: `长期均线（SMA${strategy?.smaSlow ?? ''}）：最近 ${strategy?.smaSlow ?? 'N'} 根 ${k}K 线收盘价的平均值，反映更长期的价格走向。`,
    rsi: `RSI${strategy?.rsiPeriod ?? ''}（相对强弱指数）：0 到 100，越高说明近期涨得越猛。一般认为 70 以上偏“超买”，30 以下偏“超卖”。`,
    confidence: 'LLM 对自己这次判断的把握程度，0 到 1，越接近 1 越有把握。',
    benchmark: '假设策略账本开始时把全部预算一次性买成币、之后什么都不做，到现在的收益率。用来判断策略有没有比“躺平”更好。',
    excess: '策略收益率减去“一直持有”的收益率。为正说明策略跑赢了躺平，为负说明还不如一直拿着。'
  }
}
