/** 显示用的格式化工具。金额在后端是字符串，这里只做显示，不参与计算。 */

export function fmtNumber(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return '-'
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * 价格：保留大约 6 位有效数字（至少 2 位、最多 8 位小数）。
 * BTC 这类高价币显示 2 位小数，DOGE 这类低价币也能看清变化。
 */
export function fmtPrice(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  const magnitude = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)))
  const digits = Math.min(8, Math.max(2, 5 - magnitude))
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: digits })
}

/** 币数量：最多 8 位小数，去掉末尾的 0 */
export function fmtQty(value: string | null | undefined): string {
  if (!value) return '-'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 8 }) : '-'
}

export function fmtPct(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `${n > 0 ? '+' : ''}${fmtNumber(n)}%`
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

/** 相对时间，如“3 分钟后”“2 小时前”。now 由调用方传入，便于定时刷新。 */
export function fmtRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return '-'
  const diff = new Date(iso).getTime() - now
  const minutes = Math.round(Math.abs(diff) / 60_000)
  if (minutes < 1) return diff > 0 ? '即将开始' : '刚刚'
  const amount = minutes < 60
    ? `${minutes} 分钟`
    : minutes < 1440 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`
  return diff > 0 ? `${amount}后` : `${amount}前`
}

/** 正数绿、负数红 */
export function pnlClass(value: string | number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return ''
  return n > 0 ? 'text-success' : 'text-error'
}
