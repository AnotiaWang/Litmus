/**
 * 前后端共用的接口数据类型。
 * 金额、数量、价格都是字符串（保留 decimal.js 的完整精度），前端显示时再格式化。
 */
import type { AppSettings, SeasonConfig } from '../settings'

export type Outcome
  = | 'hold' // 观望
    | 'paused' // 暂停中，不询问 LLM、不交易
    | 'risk_block' // 风控拦截
    | 'filled' // 已成交（模拟撮合）
    | 'error' // 出错

/** llm：LLM 决策；baseline：均线规则基线，不调用 LLM */
export type AgentKind = 'llm' | 'baseline'

/** LLM 这次询问的结果：ok 给出了合法决策；invalid_output 有返回但不合格；request_failed 请求失败（超时、网络、HTTP 错误） */
export type LlmStatus = 'ok' | 'invalid_output' | 'request_failed'

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

/**
 * 一条决策记录：某个模型在某一轮里做了什么。
 * 只在真正问过 LLM、触发止损、规则给出买卖信号或出错时记录；其余轮次只记资产快照。
 */
export interface Decision {
  id: string
  seasonId: number
  agentId: number
  tickId: number
  /** 这一轮行情快照的时间 */
  createdAt: string
  /** 快照价格，成交也按这个价格 */
  price: string
  /** 均线基线的指标；LLM 模型为 null */
  indicators: Record<string, number> | null
  /** 这一轮的动作：基线是规则信号；LLM 模型是 LLM 给出的动作；止损时为 sell */
  signal: 'buy' | 'sell' | 'hold' | null
  /** 程序给出的说明（止损、规则信号原因、暂停、LLM 出错等） */
  signalNote: string | null
  llmStatus: LlmStatus | null
  llmDecision: 'buy' | 'sell' | 'hold' | null
  llmSizePct: number | null
  llmConfidence: number | null
  llmReason: string | null
  llmRaw: string | null
  llmCalls: LlmCall[] | null
  llmPrompt: LlmPrompt | null
  /** 这次询问所有请求（含重试）的总耗时 */
  llmDurationMs: number | null
  llmPromptTokens: number | null
  llmCompletionTokens: number | null
  /** 重试次数（calls.length - 1）；以及其中命中的 HTTP 429 / 超时次数 */
  llmRetries: number
  llmHttp429: number
  llmTimeouts: number
  riskPassed: boolean | null
  riskRule: string | null
  riskReason: string | null
  orderSide: 'buy' | 'sell' | null
  /** 风控算出的买入金额（USDT，含手续费） */
  orderQuoteAmount: string | null
  /** 风控算出的卖出数量 */
  orderQty: string | null
  filledQty: string | null
  /** 成交金额（USDT，不含手续费） */
  filledQuote: string | null
  feeUsdt: string | null
  /** 卖出时这部分持仓的已实现盈亏（扣除买卖手续费） */
  realizedPnl: string | null
  outcome: Outcome
  error: string | null
}

/** 列表里的决策不含 LLM 原始返回、调用详情和提示词（可能较长），详情接口再给 */
export type DecisionSummary = Omit<Decision, 'llmRaw' | 'llmCalls' | 'llmPrompt'>

export interface DecisionsResponse {
  items: DecisionSummary[]
  total: number
}

export interface SeasonSummary {
  id: number
  name: string
  startedAt: string
  endedAt: string | null
  config: SeasonConfig
  /** 赛季开始时使用的提示词 / 引擎版本；历史赛季可能为 legacy */
  promptVersion: string
  engineVersion: string
}

/** 公开的模型信息：不含 Provider 地址和 Key */
export interface AgentPublic {
  id: number
  kind: AgentKind
  name: string
  color: string
  /** 请求时的模型名；基线为 null */
  model: string | null
  /** Provider 显示名；基线为 null */
  provider: string | null
  reasoningEffort: string | null
  status: 'active' | 'paused' | 'archived'
  createdAt: string
  archivedAt: string | null
}

/** 某个模型在某个赛季里的成绩和当前状态 */
export interface Standing {
  agent: AgentPublic
  joinedAt: string
  /** 归档时间；还在参赛时为 null */
  leftAt: string | null
  /** 账本初始化（第一次参与运行）的时间和价格；还没运行过时为 null */
  startedAt: string | null
  startPrice: string | null
  /** 以下为最近一次资产快照；还没运行过时为 null */
  equity: string | null
  usdt: string | null
  base: string | null
  positionValue: string | null
  /** 持仓均价（含买入手续费）；空仓时为 null */
  entryPrice: string | null
  /** 当前生效的止损价；空仓或未开启时为 null */
  stopPrice: string | null
  returnPct: string | null
  /** 同期一直持有（从 startedAt 起）的收益率 */
  benchmarkReturnPct: string | null
  /** 超额收益：收益率减去一直持有的收益率，单位是百分点 */
  excessReturnPct: string | null
  maxDrawdownPct: string | null
  /** 成交笔数、其中卖出笔数和盈利的卖出笔数 */
  trades: number
  sells: number
  wins: number
  /** 手续费合计、已实现盈亏、当前持仓的浮动盈亏 */
  feesUsdt: string
  realizedPnl: string
  unrealizedPnl: string | null
  /** 卖出盈亏比 = 盈利卖出总额 ÷ 亏损卖出总额；没有亏损卖出时为 null */
  profitFactor: number | null
  /** 整个赛季的平均持币市值占比（按每轮资产快照计算） */
  avgExposurePct: number | null
  /** 每轮收益率的标准差 × √轮数，近似整个期间的波动幅度 */
  periodVolPct: number | null
  /** 平均每轮超额收益（相对一直持有）是否显著不为 0：t = 均值 ÷ 标准误 */
  returnTStat: number | null
  /**
   * LLM 询问统计；基线为 null。asked = ok + invalidOutput + requestFailed：
   * 输出不合格是模型的问题，请求失败（超时、网络、HTTP 错误）是服务的问题，成功率只按前两种算
   */
  llm: {
    asked: number
    ok: number
    invalidOutput: number
    requestFailed: number
    /** 平均耗时，不含请求失败的询问 */
    avgDurationMs: number | null
    p50DurationMs: number | null
    p95DurationMs: number | null
    maxDurationMs: number | null
    promptTokens: number
    completionTokens: number
    /** 重试次数（含 429、超时后的第二次请求） */
    retries: number
    http429: number
    timeouts: number
    /** 按模型配置的单价估算的累计成本（USD）；没配置单价时为 null */
    costUsd: number | null
  } | null
  /** 当日亏损熔断中（只停买入）；没有时为 null */
  circuit: { reason: string, until: string } | null
}

/** 一个赛季的样本量，用来判断排行榜是否已经具备统计意义 */
export interface SampleStats {
  days: number
  rounds: number
  decisions: number
  trades: number
}

/** 当前代码里的版本，和赛季开始时记录的版本对比 */
export interface CodeVersions {
  promptVersion: string
  engineVersion: string
}

export interface StandingsResponse {
  season: SeasonSummary
  /** 最近一次行情快照的时间和价格 */
  asOf: string | null
  price: string | null
  /** 从赛季开始一直持有的收益率 */
  benchmarkReturnPct: string | null
  standings: Standing[]
  /** 本赛季的样本量 */
  sample: SampleStats
  /** 当前代码版本，前端用来提示赛季中途升级 */
  codeVersions: CodeVersions
}

export interface StatusResponse {
  /** 是否正在运行一轮 */
  running: boolean
  /** 手动暂停：所有模型都不询问 LLM、不交易，资产照常记录 */
  paused: boolean
  pausedAt: string | null
  nextRunAt: string | null
  lastTick: { at: string, error: string | null } | null
  season: SeasonSummary | null
}

export interface EquityTrade {
  t: string
  agentId: number
  side: 'buy' | 'sell'
  price: string
  qty: string
  quote: string
  realizedPnl: string | null
}

export interface EquityResponse {
  seasonId: number
  /**
   * 每个点是一轮行情快照：价格、各模型的资产总值和持币数量（按模型 ID）。
   * 模型中途加入或归档，那段时间就没有它的值
   */
  points: Array<{ t: string, price: string, values: Record<string, string>, bases: Record<string, string> }>
  /** 赛季第一轮的价格，用来画“一直持有”的参考线；还没运行过时为 null */
  startPrice: string | null
  /**
   * 所选范围开始前最后一轮的价格和各模型的资产，曲线的收益率从这里算起。
   * 范围覆盖了赛季开头（或模型是范围内才加入的）就没有对应的值，按赛季起始价和初始资金算
   */
  base: { price: string | null, values: Record<string, string> }
  /** 所选时间范围内的全部成交，用来在曲线上画买卖点 */
  trades: EquityTrade[]
  /** 正常运行时相邻两点的间隔（毫秒）：运行间隔 × 抽样步长，用来识别停机造成的断档 */
  intervalMs: number
}

export type RunResult
  = | { status: 'busy' }
    | { status: 'done', tickId: number | null, error: string | null, outcomes: Array<{ agentId: number, outcome: Outcome, decisionId: string | null }> }

/** 当前访问者的权限，前端据此决定显示登录框还是公开页面 */
export interface SessionResponse {
  publicRead: boolean
  admin: boolean
}

export interface ProviderView {
  id: number
  name: string
  baseUrl: string
  /** 打码后的 Key，如 sk-a…wxyz */
  apiKeyMasked: string
  createdAt: string
  /** 挂在这个 Provider 下的模型数（含已归档），有模型时不能删除 */
  agentCount: number
}

export interface AgentAdminView extends AgentPublic {
  providerId: number | null
  timeoutSeconds: number | null
  extraParams: Record<string, unknown> | null
  /** 可选的 token 单价（每百万 token，美元），只用于面板估算成本，不影响交易 */
  inputPricePerM: number | null
  outputPricePerM: number | null
  /** 还没有任何资产快照和决策记录时可以直接删除，否则只能归档 */
  deletable: boolean
}

/** 管理页的模型健康数据：按赛季汇总 LLM 稳定性 */
export interface AdminHealthModel {
  agentId: number
  name: string
  color: string
  status: AgentPublic['status']
  lastAskedAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  asked: number
  ok: number
  invalidOutput: number
  requestFailed: number
  retries: number
  http429: number
  timeouts: number
  avgDurationMs: number | null
  p50DurationMs: number | null
  p95DurationMs: number | null
  maxDurationMs: number | null
  promptTokens: number
  completionTokens: number
  costUsd: number | null
}

export interface AdminHealthResponse {
  seasonId: number
  asOf: string | null
  models: AdminHealthModel[]
}

export interface AdminSettingsResponse {
  app: AppSettings
}

/** 测试一个模型：用当前行情和一个空仓账本问一次，不记录、不交易 */
export interface AgentTestResult {
  ok: boolean
  action: 'buy' | 'sell' | 'hold'
  sizePct: number
  confidence: number
  reason: string
  error: string | null
  durationMs: number
  calls: LlmCall[]
}
