/** 测试共用：构造配置、K 线和完整的模拟环境。 */
import Decimal from 'decimal.js'
import { settingsSchema } from '../../shared/settings'
import { loadEnvConfig, resolveConfig, type Config } from '../../server/lib/config'
import { Store } from '../../server/lib/db'
import { Engine } from '../../server/lib/engine'
import { MockExchange, type Kline } from '../../server/lib/exchange'
import { MockLlm } from '../../server/lib/llm'

export const BASE_ENV = {
  BINANCE_API_KEY: 'test-binance-key-AAAA',
  BINANCE_API_SECRET: 'test-binance-secret-BBBB',
  LLM_BASE_URL: 'http://llm.local/v1',
  LLM_API_KEY: 'test-llm-key-CCCC',
  LLM_MODEL: 'test-model',
  ADMIN_TOKEN: 'admin-token-0123456789'
}

/** 测试用的面板设置覆盖项，值的写法和面板提交的一样（金额可以是字符串或数字） */
export type SettingsOverrides = Record<string, string | number | boolean>

/**
 * 测试行情大多构造成“最后一根 K 线刚好交叉”，不少用例还要用到 RSI 止盈，
 * 所以默认不做信号确认、止盈设为 80。这两项的默认值和行为有单独的用例。
 */
export const FIXTURE_SETTINGS: SettingsOverrides = { confirmBars: 1, rsiSellMin: 80 }

export function testConfig(settings: SettingsOverrides = {}, env: Record<string, string> = {}): Config {
  return resolveConfig(loadEnvConfig({ ...BASE_ENV, ...env }), settingsSchema.parse({ ...FIXTURE_SETTINGS, ...settings }))
}

const HOUR = 3_600_000

/** 用收盘价序列构造 1 小时 K 线，最后一根在 end 之前收盘。 */
export function makeKlines(closes: number[], end: number): Kline[] {
  const start = end - closes.length * HOUR
  return closes.map((c, i) => ({
    openTime: start + i * HOUR,
    open: String(c),
    high: String(c * 1.01),
    low: String(c * 0.99),
    close: String(c),
    volume: '1',
    closeTime: start + (i + 1) * HOUR - 1
  }))
}

/**
 * 构造“最后一根 K 线刚好出现交叉”的收盘价序列：
 * 前 80 根在 base，接着 19 根在 base + step，最后一根跳到 last。
 * 再叠加 ±noise 的交替波动：20 和 50 都是偶数，交替波动在均线窗口内正好抵消，不影响交叉，
 * 但能让 RSI 落在正常区间（否则一根大阳线会把 RSI 推到接近 100）。
 */
function crossCloses(base: number, step: number, last: number, noise = 1000): number[] {
  const closes = [...Array<number>(80).fill(base), ...Array<number>(19).fill(base + step), last]
  return closes.map((c, i) => c + (i % 2 ? noise : -noise))
}

/** 最新一根出现金叉（SMA20 上穿 SMA50），RSI 约 57 */
export const goldenCrossCloses = () => crossCloses(50000, -100, 52000)

/** 最新一根出现死叉 */
export const deathCrossCloses = () => crossCloses(50000, 100, 48000)

/** 金叉但 RSI 过热（没有波动，最后一根大阳线） */
export const hotGoldenCrossCloses = () => crossCloses(50000, -100, 52000, 0)

/** 稳定上涨：没有交叉，RSI = 100 */
export const steadyRiseCloses = () => Array.from({ length: 100 }, (_, i) => 40000 + i * 100)

/** 横盘震荡：没有交叉 */
export function flatCloses(): number[] {
  return Array.from({ length: 100 }, (_, i) => 50000 + (i % 2 ? 20 : -20))
}

export const NOW = new Date('2026-10-08T12:00:30.000Z')

export function setup(opts: { settings?: SettingsOverrides, env?: Record<string, string>, closes?: number[], llm?: Array<string | Error> | null } = {}) {
  const envConfig = loadEnvConfig({ ...BASE_ENV, ...opts.env })
  const exchange = new MockExchange()
  exchange.klines = makeKlines(opts.closes ?? flatCloses(), NOW.getTime() - 30_000)
  exchange.price = new Decimal(exchange.klines.at(-1)!.close)
  const reviewer = opts.llm === null ? null : new MockLlm(opts.llm)
  const store = new Store(':memory:')
  store.setSettings(settingsSchema.parse({ ...FIXTURE_SETTINGS, ...opts.settings }))
  // 和线上一样每次读最新的设置，测试里改了 store 里的设置，下一轮就生效
  const config = () => resolveConfig(envConfig, store.getSettings())
  let now = NOW
  let seq = 0
  const engine = new Engine({
    config,
    exchange,
    reviewer,
    decider: reviewer,
    store,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
    newId: () => `d-${++seq}`
  })
  return {
    config,
    exchange,
    reviewer,
    store,
    engine,
    setNow: (d: Date) => {
      now = d
    }
  }
}
