/**
 * 前后端共用的设置校验：赛季配置和站点设置。面板表单提交前校验一次，服务端保存前再校验一次。
 *
 * - 赛季配置：交易对、初始资金、决策周期、风险预设等所有影响交易结果的参数。赛季开始时定下，赛季内不能改，
 *   要换参数就开新赛季——否则同一条资产曲线里混着两套规则，模型之间也没法比
 * - 站点设置：是否公开浏览等，随时可以改，不影响交易
 *
 * 金额以字符串保存（保留完整精度），表单里填数字也可以。
 */
import { z } from 'zod'

/** 决策周期（K 线周期）。更短的周期每天要问几十上百次 LLM，成本太高，不提供 */
export const KLINE_INTERVALS = ['15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'] as const
export type KlineInterval = typeof KLINE_INTERVALS[number]

/** 发给 LLM 的 K 线最多多少根（引擎每轮取 100 根） */
export const LLM_KLINES_MAX = 100

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int('必须是整数').min(min, `不能小于 ${min}`).max(max, `不能大于 ${max}`).default(fallback)
const num = (fallback: number, min: number, max: number) =>
  z.coerce.number().min(min, `不能小于 ${min}`).max(max, `不能大于 ${max}`).default(fallback)
const money = (fallback: string) =>
  z.coerce.string().trim().default(fallback).refine(
    v => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0,
    '必须是大于 0 的数字'
  )

/** 风控参数：程序在模型的决定之上执行的限制，只会调小金额或拦下交易 */
export const riskSchema = z.object({
  /** 止损：价格比持仓均价低这么多 % 时全部卖出，0 为关闭 */
  stopLossPct: num(0, 0, 99),
  /** 移动止损：价格比持仓以来最高价低这么多 % 时全部卖出，0 为关闭 */
  trailingStopPct: num(0, 0, 99),
  /** 单笔买入最多动用总资产的百分之几 */
  maxOrderPct: num(100, 1, 100),
  /** 持币市值最多占总资产的百分之几 */
  maxPositionPct: num(100, 1, 100),
  /** 每天（UTC）最多成交几笔（买卖都算）；达到后当天不再买入，卖出不受限 */
  maxTradesPerDay: int(12, 1, 1000),
  /** 上一笔成交后至少间隔多少分钟才能再买入 */
  cooldownMinutes: int(0, 0, 10080),
  /** 当日亏损达到这么多 % 时，当天不再买入（卖出照常） */
  dailyLossLimitPct: num(15, 0.01, 100)
})
export type RiskParams = z.output<typeof riskSchema>

/**
 * 风险预设。护栏越紧，各模型的结果越接近——管得越多，测出来的越是程序的风控而不是模型的判断，
 * 所以默认用最宽松的“激进”。
 */
export const RISK_PRESETS = {
  conservative: { stopLossPct: 3, trailingStopPct: 5, maxOrderPct: 25, maxPositionPct: 50, maxTradesPerDay: 4, cooldownMinutes: 120, dailyLossLimitPct: 3 },
  moderate: { stopLossPct: 5, trailingStopPct: 0, maxOrderPct: 50, maxPositionPct: 80, maxTradesPerDay: 6, cooldownMinutes: 60, dailyLossLimitPct: 5 },
  aggressive: { stopLossPct: 10, trailingStopPct: 0, maxOrderPct: 100, maxPositionPct: 100, maxTradesPerDay: 12, cooldownMinutes: 0, dailyLossLimitPct: 15 }
} as const satisfies Record<string, RiskParams>

export type RiskPreset = keyof typeof RISK_PRESETS | 'custom'

export const RISK_PRESET_LABELS: Record<RiskPreset, string> = {
  conservative: '保守',
  moderate: '温和',
  aggressive: '激进',
  custom: '自定义'
}

/**
 * 赛季配置的字段。保存下来的配置用这个读取（不套用预设），赛季开始后预设的定义改了也不会影响已有赛季；
 * 新建赛季时用下面的 seasonConfigSchema，把预设展开成具体数值再保存。
 */
export const seasonConfigFieldsSchema = z.object({
  /** 交易对，只支持以 USDT 计价的现货 */
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,15}USDT$/, '交易对格式不对，只支持以 USDT 计价的现货，例如 BTCUSDT').default('BTCUSDT'),
  /** 每个模型的初始资金（USDT），所有模型相同 */
  initialCapital: money('1500'),
  /** 决策周期：每根这个周期的 K 线收盘后问一次 LLM */
  klineInterval: z.enum(KLINE_INTERVALS).default('1h'),
  /** 每隔多少分钟运行一轮（按整点对齐）。两次询问 LLM 之间的轮次只检查止损、记录资产 */
  checkIntervalMinutes: int(15, 1, 1440),
  /** 发给 LLM 的已收盘 K 线根数 */
  llmKlines: int(48, 10, LLM_KLINES_MAX),
  riskPreset: z.enum(['conservative', 'moderate', 'aggressive', 'custom']).default('aggressive'),
  /** riskPreset 为 custom 时使用；其他预设会被替换成预设的值 */
  risk: riskSchema.default(RISK_PRESETS.aggressive)
})

export const seasonConfigSchema = seasonConfigFieldsSchema.transform(v => v.riskPreset === 'custom' ? v : { ...v, risk: { ...RISK_PRESETS[v.riskPreset] } })

export type SeasonConfig = z.output<typeof seasonConfigSchema>

export const DEFAULT_SEASON_CONFIG: SeasonConfig = seasonConfigSchema.parse({})

/** 站点设置：随时可以改，不影响交易 */
export const appSettingsSchema = z.object({
  /** 开启后任何人都能浏览排行榜、曲线和决策记录；管理操作始终需要口令 */
  publicRead: z.boolean().default(true)
})

export type AppSettings = z.output<typeof appSettingsSchema>
