/**
 * 面板里可以调整的运行参数（预算、运行间隔、决策方式、策略、风控、LLM）。
 *
 * 保存在数据库里，改了马上生效，不用重启；没保存过的项使用这里的默认值。
 * 前后端共用同一份校验：面板表单提交前校验一次，服务端保存前再校验一次。
 * 金额以字符串保存（保留完整精度），表单里填数字也可以。
 */
import { z } from 'zod'

export const KLINE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'] as const

/** 策略取 100 根 K 线，长期均线最多 98 根（交叉判断还要用到前一根） */
export const SMA_SLOW_MAX = 98
/** 信号确认最多看几根 K 线 */
export const CONFIRM_BARS_MAX = 10
/** LLM 决策模式最多发给 LLM 多少根 K 线（引擎每轮取 100 根） */
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

export const settingsSchema = z.object({
  /** 策略起始资金（USDT）。修改后策略账本会在下一轮重新开始 */
  budgetUsdt: money('100'),
  /** 每隔多少分钟运行一轮，按整点对齐 */
  intervalMinutes: int(15, 1, 1440),
  /** rules：均线 + RSI 规则产生信号（可选 LLM 复核买入）；llm：LLM 直接决定买卖。两种模式都由代码执行止损和风控 */
  decisionMode: z.enum(['rules', 'llm']).default('rules'),
  /** 规则模式：是否用 LLM 复核买入（还需要在 .env 里配置 LLM 连接信息） */
  llmEnabled: z.boolean().default(true),

  /** LLM 决策模式多久问一次 LLM：candle 每根 K 线收盘后一次；interval 每 llmIntervalMinutes 分钟一次。其余轮次只检查止损 */
  llmCadence: z.enum(['candle', 'interval']).default('candle'),
  /** llmCadence 为 interval 时的间隔（分钟），按整点对齐 */
  llmIntervalMinutes: int(60, 1, 1440),
  /** LLM 决策模式发给 LLM 的已收盘 K 线根数 */
  llmKlines: int(48, 10, LLM_KLINES_MAX),

  klineInterval: z.enum(KLINE_INTERVALS).default('1h'),
  /** trend：按均线所处状态（短期在长期上方 / 下方）；cross：只在均线交叉的那根 K 线上 */
  signalMode: z.enum(['trend', 'cross']).default('trend'),
  /** trend 模式：短期均线要连续这么多根已收盘 K 线都在长期均线上方 / 下方才买 / 卖，1 为不确认 */
  confirmBars: int(2, 1, CONFIRM_BARS_MAX),
  smaFast: int(20, 2, SMA_SLOW_MAX - 1),
  smaSlow: int(50, 3, SMA_SLOW_MAX),
  rsiPeriod: int(14, 2, 50),
  rsiBuyMax: num(70, 1, 100),
  /** 持仓时 RSI 高于此值止盈卖出；100 为关闭（RSI 不会超过 100） */
  rsiSellMin: num(100, 1, 100),
  /** 止损：价格比持仓均价低这么多 % 时卖出，0 为关闭 */
  stopLossPct: num(5, 0, 99),
  /** 移动止损：价格比持仓以来最高价低这么多 % 时卖出，0 为关闭 */
  trailingStopPct: num(0, 0, 99),

  maxOrderUsdt: money('50'),
  maxPositionPct: num(50, 1, 100),
  maxTradesPerDay: int(6, 1, 1000),
  cooldownMinutes: int(60, 0, 10080),
  dailyLossLimitPct: num(5, 0.01, 100)
}).superRefine((v, ctx) => {
  if (v.smaFast >= v.smaSlow) {
    ctx.addIssue({ code: 'custom', path: ['smaFast'], message: '必须小于长期均线' })
  }
  // 往前数 confirmBars 根时，每根都要有足够的 K 线算长期均线（策略共取 SMA_SLOW_MAX + 2 = 100 根）
  if (v.smaSlow + v.confirmBars > SMA_SLOW_MAX + 2) {
    ctx.addIssue({ code: 'custom', path: ['confirmBars'], message: `长期均线 + 确认根数不能超过 ${SMA_SLOW_MAX + 2}` })
  }
})

export type Settings = z.output<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({})

/**
 * 这些参数以前用环境变量配置。现在只有回测命令还认它们（临时换参数试试，不影响面板里的设置），
 * 正式服务启动时如果发现 .env 里还有，会提示已经不生效。
 */
export const LEGACY_ENV_KEYS = {
  BUDGET_USDT: 'budgetUsdt',
  INTERVAL_MINUTES: 'intervalMinutes',
  LLM_ENABLED: 'llmEnabled',
  KLINE_INTERVAL: 'klineInterval',
  SIGNAL_MODE: 'signalMode',
  CONFIRM_BARS: 'confirmBars',
  SMA_FAST: 'smaFast',
  SMA_SLOW: 'smaSlow',
  RSI_PERIOD: 'rsiPeriod',
  RSI_BUY_MAX: 'rsiBuyMax',
  RSI_SELL_MIN: 'rsiSellMin',
  STOP_LOSS_PCT: 'stopLossPct',
  TRAILING_STOP_PCT: 'trailingStopPct',
  MAX_ORDER_USDT: 'maxOrderUsdt',
  MAX_POSITION_PCT: 'maxPositionPct',
  MAX_TRADES_PER_DAY: 'maxTradesPerDay',
  COOLDOWN_MINUTES: 'cooldownMinutes',
  DAILY_LOSS_LIMIT_PCT: 'dailyLossLimitPct'
} as const satisfies Record<string, keyof Settings>
