/**
 * 环境变量：只放部署相关的内容（面板口令、数据目录）。
 *
 * 开发时 nuxt dev 自动加载 .env，生产由 Docker Compose 注入，不使用 Nuxt runtimeConfig 的 NUXT_ 前缀约定。
 * Provider、模型、赛季参数都在面板里管理，存在数据库里。
 * 任何一项不合法都直接拒绝启动。
 */
import { z } from 'zod'

const schema = z.object({
  ADMIN_TOKEN: z.string().trim().min(1, '必填，可以用 `openssl rand -hex 24` 生成'),
  DATA_DIR: z.string().trim().default('./data')
})

export interface EnvConfig {
  adminToken: string
  dataDir: string
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
  return { adminToken: parsed.data.ADMIN_TOKEN, dataDir: parsed.data.DATA_DIR }
}

/** 旧版本用过、现在已经不再使用的环境变量 */
const LEGACY_ENV_KEYS = [
  'BINANCE_ENV', 'BINANCE_BASE_URL', 'BINANCE_API_KEY', 'BINANCE_API_SECRET', 'SYMBOL',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_REASONING_EFFORT', 'LLM_TIMEOUT_SECONDS',
  'BUDGET_USDT', 'INTERVAL_MINUTES', 'LLM_ENABLED', 'KLINE_INTERVAL', 'SIGNAL_MODE', 'CONFIRM_BARS',
  'SMA_FAST', 'SMA_SLOW', 'RSI_PERIOD', 'RSI_BUY_MAX', 'RSI_SELL_MIN', 'STOP_LOSS_PCT', 'TRAILING_STOP_PCT',
  'MAX_ORDER_USDT', 'MAX_POSITION_PCT', 'MAX_TRADES_PER_DAY', 'COOLDOWN_MINUTES', 'DAILY_LOSS_LIMIT_PCT'
]

/** .env 里还留着、但已经不再使用的旧变量名，启动时提示可以删掉。 */
export function legacyEnvKeys(env: Record<string, string | undefined> = process.env): string[] {
  const set = filled(env)
  return LEGACY_ENV_KEYS.filter(key => key in set)
}
