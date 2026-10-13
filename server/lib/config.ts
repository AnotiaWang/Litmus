/**
 * 配置：读取并校验环境变量，再和面板里的设置合并成实际生效的配置。
 *
 * 环境变量只放部署相关的内容：密钥、交易所环境、交易对、LLM 连接信息、面板口令
 * （开发时 nuxt dev 自动加载 .env，生产由 Docker Compose 注入），不使用 Nuxt runtimeConfig 的 NUXT_ 前缀约定。
 * 预算、运行间隔、策略和风控参数在面板里调整，存在数据库里（见 shared/settings.ts）。
 * 任何一项不合法都直接拒绝启动——宁可起不来，也不要带着错误配置去下单。
 *
 * 安全：交易所地址只能是 Demo Mode 或测试网，白名单写死在代码里。
 */
import Decimal from 'decimal.js'
import { z } from 'zod'
import { LEGACY_ENV_KEYS, type Settings } from '../../shared/settings'

/** 允许连接的交易所地址。真实交易环境（api.binance.com 等）不在其中。 */
export const BINANCE_URLS = {
  demo: 'https://demo-api.binance.com',
  testnet: 'https://testnet.binance.vision'
} as const

export type BinanceEnv = keyof typeof BINANCE_URLS

const ALLOWED_BINANCE_URLS: readonly string[] = Object.values(BINANCE_URLS)

/** 地址不在白名单内时抛错。交易所客户端构造时也会再调用一次，双重保险。 */
export function assertAllowedBinanceUrl(url: string): void {
  if (!ALLOWED_BINANCE_URLS.includes(url.replace(/\/+$/, ''))) {
    throw new Error(`交易所地址 ${url} 不在白名单内，只允许：${ALLOWED_BINANCE_URLS.join('、')}`)
  }
}

// 环境变量里的值都是字符串，下面这些小工具负责转换并给出中文报错
const str = (fallback?: string) => {
  const s = z.string().trim()
  return fallback === undefined ? s.min(1, '必填') : s.default(fallback)
}
const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int('必须是整数').min(min, `不能小于 ${min}`).max(max, `不能大于 ${max}`).default(fallback)

const LLM_CONNECTION_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const

const schema = z.object({
  BINANCE_ENV: z.enum(['demo', 'testnet']).default('demo'),
  // 可选：显式指定地址，但同样只能是白名单里的两个
  BINANCE_BASE_URL: z.string().trim().optional(),
  BINANCE_API_KEY: str(),
  BINANCE_API_SECRET: str(),

  SYMBOL: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5,20}$/, '交易对格式不对，例如 BTCUSDT').default('BTCUSDT'),

  // 三项都不填表示不使用 LLM；要用就三项都填
  LLM_BASE_URL: z.string().trim().optional(),
  LLM_API_KEY: z.string().trim().optional(),
  LLM_MODEL: z.string().trim().optional(),
  LLM_REASONING_EFFORT: z.string().trim().regex(/^[a-z]+$/, '只能是小写英文单词，如 low、medium、high').optional(),
  LLM_TIMEOUT_SECONDS: int(30, 5, 120),

  ADMIN_TOKEN: str(),
  DATA_DIR: str('./data')
}).superRefine((v, ctx) => {
  const filled = LLM_CONNECTION_KEYS.filter(key => v[key])
  if (filled.length && filled.length < LLM_CONNECTION_KEYS.length) {
    for (const key of LLM_CONNECTION_KEYS) {
      if (!v[key]) ctx.addIssue({ code: 'custom', path: [key], message: `使用 LLM 时 ${LLM_CONNECTION_KEYS.join('、')} 三项都要填写` })
    }
  }
  if (v.LLM_BASE_URL && !/^https?:\/\//.test(v.LLM_BASE_URL)) {
    ctx.addIssue({ code: 'custom', path: ['LLM_BASE_URL'], message: '必须以 http:// 或 https:// 开头' })
  }
  const url = v.BINANCE_BASE_URL || BINANCE_URLS[v.BINANCE_ENV]
  try {
    assertAllowedBinanceUrl(url)
  } catch (e) {
    ctx.addIssue({ code: 'custom', path: ['BINANCE_BASE_URL'], message: (e as Error).message })
  }
})

/** 来自环境变量的配置：密钥、交易所、交易对、LLM 连接信息等，改了需要重启。 */
export interface EnvConfig {
  binance: { env: BinanceEnv, baseUrl: string, apiKey: string, apiSecret: string }
  symbol: string
  llm: {
    /** 是否配置了 LLM 连接信息；没配置时面板里也不能开启 LLM */
    configured: boolean
    baseUrl: string
    apiKey: string
    model: string
    /** 思考强度（reasoning_effort），为 null 时不发送，用模型默认值 */
    reasoningEffort: string | null
    /** 单次请求超时（毫秒） */
    timeoutMs: number
  }
  adminToken: string
  dataDir: string
}

/** 实际生效的配置：环境变量 + 面板里的设置（见 shared/settings.ts）。每轮决策开始时取一次。 */
export interface Config extends Omit<EnvConfig, 'llm'> {
  budgetUsdt: Decimal
  intervalMinutes: number
  decision: {
    /** rules：规则信号（可选 LLM 复核买入）；llm：LLM 直接决定买入 / 卖出 / 观望 */
    mode: 'rules' | 'llm'
    /** LLM 决策模式：candle 每根 K 线收盘后问一次；interval 每 llmIntervalMinutes 分钟问一次 */
    llmCadence: 'candle' | 'interval'
    llmIntervalMinutes: number
    /** LLM 决策模式发给 LLM 的 K 线根数 */
    llmKlines: number
  }
  strategy: {
    klineInterval: string
    smaFast: number
    smaSlow: number
    rsiPeriod: number
    rsiBuyMax: number
    rsiSellMin: number
    /** trend：按均线所处状态（短期在长期上方 / 下方）；cross：只在均线交叉的那根 K 线上 */
    mode: 'trend' | 'cross'
    /** trend 模式：均线状态要连续这么多根已收盘 K 线成立才买 / 卖 */
    confirmBars: number
    /** 止损：价格比持仓均价低这么多 % 时卖出，0 为关闭 */
    stopLossPct: number
    /** 移动止损：价格比持仓以来最高价低这么多 % 时卖出，0 为关闭 */
    trailingStopPct: number
  }
  llm: EnvConfig['llm'] & {
    /** 规则模式：面板里开启了 LLM 复核，并且配置了连接信息 */
    enabled: boolean
  }
  risk: {
    maxOrderUsdt: Decimal
    maxPositionPct: number
    maxTradesPerDay: number
    cooldownMinutes: number
    dailyLossLimitPct: number
  }
}

/** 配置不合法时抛出，message 里逐项列出原因（不包含任何密钥的值）。 */
export class ConfigError extends Error {}

/** 空字符串视为未填写，这样 .env 里留空的行会使用默认值 */
const filled = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')) as Record<string, string>

export function loadEnvConfig(env: Record<string, string | undefined> = process.env): EnvConfig {
  const parsed = schema.safeParse(filled(env))
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  - ${i.path.join('.') || '(整体)'}：${i.message}`)
    throw new ConfigError(`配置校验失败：\n${lines.join('\n')}`)
  }
  const v = parsed.data
  return {
    binance: {
      env: v.BINANCE_ENV,
      baseUrl: (v.BINANCE_BASE_URL || BINANCE_URLS[v.BINANCE_ENV]).replace(/\/+$/, ''),
      apiKey: v.BINANCE_API_KEY,
      apiSecret: v.BINANCE_API_SECRET
    },
    symbol: v.SYMBOL,
    llm: {
      configured: Boolean(v.LLM_BASE_URL && v.LLM_API_KEY && v.LLM_MODEL),
      baseUrl: (v.LLM_BASE_URL ?? '').replace(/\/+$/, ''),
      apiKey: v.LLM_API_KEY ?? '',
      model: v.LLM_MODEL ?? '',
      reasoningEffort: v.LLM_REASONING_EFFORT ?? null,
      timeoutMs: v.LLM_TIMEOUT_SECONDS * 1000
    },
    adminToken: v.ADMIN_TOKEN,
    dataDir: v.DATA_DIR
  }
}

/** 合并环境变量配置和面板设置。 */
export function resolveConfig(env: EnvConfig, s: Settings): Config {
  return {
    ...env,
    budgetUsdt: new Decimal(s.budgetUsdt),
    intervalMinutes: s.intervalMinutes,
    decision: {
      mode: s.decisionMode,
      llmCadence: s.llmCadence,
      llmIntervalMinutes: s.llmIntervalMinutes,
      llmKlines: s.llmKlines
    },
    strategy: {
      klineInterval: s.klineInterval,
      smaFast: s.smaFast,
      smaSlow: s.smaSlow,
      rsiPeriod: s.rsiPeriod,
      rsiBuyMax: s.rsiBuyMax,
      rsiSellMin: s.rsiSellMin,
      mode: s.signalMode,
      confirmBars: s.confirmBars,
      stopLossPct: s.stopLossPct,
      trailingStopPct: s.trailingStopPct
    },
    llm: { ...env.llm, enabled: s.llmEnabled && env.llm.configured },
    risk: {
      maxOrderUsdt: new Decimal(s.maxOrderUsdt),
      maxPositionPct: s.maxPositionPct,
      maxTradesPerDay: s.maxTradesPerDay,
      cooldownMinutes: s.cooldownMinutes,
      dailyLossLimitPct: s.dailyLossLimitPct
    }
  }
}

/** .env 里还留着、但已经改到面板里设置的旧变量名。 */
export function legacyEnvKeys(env: Record<string, string | undefined> = process.env): string[] {
  const set = filled(env)
  return Object.keys(LEGACY_ENV_KEYS).filter(key => key in set)
}

/** 回测用：把命令行里临时传入的旧变量名转换成设置项，覆盖在面板设置上。 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const set = filled(env)
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(LEGACY_ENV_KEYS)) {
    const value = set[key]?.trim()
    if (value === undefined) continue
    out[field] = field === 'llmEnabled' ? value === 'true' || value === '1' : value
  }
  return out
}

/** 需要在日志里打码的值：交易所 Key/Secret、LLM Key、面板口令。 */
export function secretsOf(config: EnvConfig): string[] {
  return [config.binance.apiKey, config.binance.apiSecret, config.llm.apiKey, config.adminToken].filter(Boolean)
}
