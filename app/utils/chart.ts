/** 收益率 / 回撤 / 仓位曲线共用的 Chart.js 小工具。 */

export const HOUR = 3_600_000

export type ChartPoint = { x: number, y: number | null, v?: number }

/**
 * 两点间隔超过常规间隔的 3 倍时视为断档，插入空值让曲线断开。
 * 常规间隔取后端给的运行间隔和 75% 分位数间隔中较大的一个。
 */
export function withGaps(values: ChartPoint[], intervalMs: number): ChartPoint[] {
  if (values.length < 3) return values
  const diffs = values.slice(1).map((v, i) => v.x - values[i]!.x).sort((a, b) => a - b)
  const threshold = Math.max(intervalMs, diffs[Math.floor(diffs.length * 0.75)]!) * 3
  const out: ChartPoint[] = [values[0]!]
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!
    if (values[i]!.x - prev.x > threshold) out.push({ x: (prev.x + values[i]!.x) / 2, y: null })
    out.push(values[i]!)
  }
  return out
}

const TICK_STEPS = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720, 2160].map(h => h * HOUR)

/** 刻度对齐到本地时间的整点 / 0 点，最多 8 个刻度 */
export function alignedTicks(min: number, max: number): Array<{ value: number }> {
  const step = TICK_STEPS.find(s => (max - min) / s <= 8) ?? TICK_STEPS.at(-1)!
  const offset = -new Date(min).getTimezoneOffset() * 60_000
  const ticks = []
  for (let t = Math.ceil((min + offset) / step) * step - offset; t <= max; t += step) ticks.push({ value: t })
  return ticks
}

/** 横轴刻度：跨度 1 天内只显示时分，7 天内显示日期和时分，更长只显示日期 */
export function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms)
  if (spanMs <= 36 * HOUR) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (spanMs <= 8 * 24 * HOUR) return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\//g, '-')
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

/** #rrggbb → rgba(r, g, b, a) */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(100, 116, 139, ${alpha})`
  const n = Number.parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
