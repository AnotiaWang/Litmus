/**
 * 前后端共用的接口数据类型。
 * 金额、数量、价格都是字符串（保留 decimal.js 的完整精度），前端显示时再格式化。
 */
import type { Settings } from '../settings'

export type Outcome
  = | 'running' // 正在运行（进程中断时会留下这个状态）
    | 'hold' // 观望
    | 'paused' // 暂停中，只记录信号
    | 'llm_reject' // LLM 否决
    | 'risk_block' // 风控拦截
    | 'filled' // 已成交
    | 'unfilled' // 已提交但没有成交
    | 'error' // 出错
    | 'interrupted' // 进程中断

/**
 * 一次 LLM 请求的记录（重试时每次一条），供面板查看调用详情。
 * 不含请求头（里面有 API Key）。思考过程和输出过长时会截断并注明。
 */
export interface LlmCall {
  startedAt: string
  durationMs: number
  /** 请求的模型 */
  model: string
  /** 服务实际返回的模型名（有的代理会换模型） */
  responseModel: string | null
  reasoningEffort: string | null
  /** 是否带了 response_format: json_object */
  jsonMode: boolean
  httpStatus: number | null
  finishReason: string | null
  /** 思考过程（reasoning_content / reasoning / <think>）；服务没有返回时为 null */
  reasoning: string | null
  /** 最终输出 */
  content: string | null
  usage: {
    promptTokens: number | null
    completionTokens: number | null
    /** 输出中用于思考的部分 */
    reasoningTokens: number | null
    totalTokens: number | null
  } | null
  /** 这次请求失败或输出不合格的原因 */
  error: string | null
}

/** 发给 LLM 的提示词，两次重试用的是同一份 */
export interface LlmPrompt {
  system: string
  user: string
}

export interface Decision {
  id: string
  createdAt: string
  trigger: 'schedule' | 'manual'
  symbol: string
  /** 这一轮的决策方式；升级前的旧记录为 null（都是规则模式） */
  mode: 'rules' | 'llm' | null
  price: string | null
  /** 规则模式的指标；LLM 决策模式不计算，为 null */
  indicators: Record<string, number> | null
  /** 规则模式是规则信号；LLM 决策模式是 LLM 给出的动作（止损时为 sell） */
  signal: 'buy' | 'sell' | 'hold' | null
  /** 信号说明。LLM 决策模式只在程序代为处理时有（止损、没到询问时间、暂停、LLM 出错等） */
  signalNote: string | null
  /** 规则模式：复核结论 approve / reject；LLM 决策模式：buy / sell / hold */
  llmDecision: 'approve' | 'reject' | 'buy' | 'sell' | 'hold' | null
  llmSizePct: number | null
  llmConfidence: number | null
  llmReason: string | null
  llmRaw: string | null
  /** 升级前的旧记录为 null */
  llmCalls: LlmCall[] | null
  llmPrompt: LlmPrompt | null
  riskPassed: boolean | null
  riskRule: string | null
  riskReason: string | null
  orderSide: 'BUY' | 'SELL' | null
  orderQuoteAmount: string | null
  orderQty: string | null
  orderId: string | null
  orderStatus: string | null
  filledQty: string | null
  filledQuote: string | null
  commission: string | null
  outcome: Outcome
  error: string | null
}

/** 列表里的决策不含 LLM 原始返回和调用详情（可能较长），详情接口再给 */
export type DecisionSummary = Omit<Decision, 'llmRaw' | 'llmCalls' | 'llmPrompt'>

export interface DecisionsResponse {
  items: DecisionSummary[]
  total: number
}

export interface StatusResponse {
  running: boolean
  paused: boolean
  pauseReason: string | null
  pauseSource: 'manual' | 'daily_loss' | 'reconcile' | null
  pausedUntil: string | null
  mode: 'demo' | 'testnet'
  symbol: string
  intervalMinutes: number
  decisionMode: 'rules' | 'llm'
  /** LLM 决策模式的询问频率说明，如“每根 4h K 线收盘后”；规则模式为 null */
  llmCadence: string | null
  llmEnabled: boolean
  /** 策略参数，面板用来解释指标（如“SMA20 = 最近 20 根 1h K 线的平均价”） */
  strategy: { klineInterval: string, smaFast: number, smaSlow: number, rsiPeriod: number }
  nextRunAt: string | null
  lastRunAt: string | null
}

export type AccountResponse
  = | { ready: false, baseAsset: string, budget: string }
    | {
      ready: true
      asOf: string
      baseAsset: string
      budget: string
      initialPrice: string
      startedAt: string
      price: string
      usdt: string
      base: string
      positionValue: string
      /** 持仓均价（含买入手续费）；空仓时为 null */
      entryPrice: string | null
      /** 当前生效的止损价（止损 / 移动止损中较高的一条）；空仓或未开启时为 null */
      stopPrice: string | null
      total: string
      returnPct: string
      benchmark: string
      benchmarkReturnPct: string
      /** 超额收益：策略收益率减去一直持有的收益率，单位是百分点 */
      excessReturnPct: string
    }

export interface EquityResponse {
  points: Array<{ t: string, total: string, benchmark: string, price: string }>
  /** 正常运行时相邻两点的间隔（毫秒）：当前运行间隔 × 抽样步长。手动运行会多出点，实际间隔只会更短 */
  intervalMs: number
}

export type RunResult
  = | { status: 'busy' }
    | { status: 'done', decisionId: string, outcome: Outcome }

export interface SettingsResponse {
  settings: Settings
  /** .env 里是否配置了 LLM 连接信息；没配置时不能开启 LLM */
  llmConfigured: boolean
  /** 现在不能修改预算的原因（持仓中、正在运行）；可以修改时为 null */
  budgetLock: string | null
}
