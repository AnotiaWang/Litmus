/**
 * 日志：同时写标准输出和 ./data/logs/app-YYYY-MM-DD.log（UTC 日期），文件保留 14 天。
 *
 * 所有输出在写出前都会做脱敏：调用 setSecrets() 登记的 Key、口令一旦出现在日志里，
 * 会被替换成 ***。这是兜底措施，正常代码路径本来就不应该把它们写进日志。
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 14

type Level = 'info' | 'warn' | 'error'

let secrets: string[] = []
let logDir: string | null = null
let currentDay = ''

/** 登记需要打码的敏感值。 */
export function setSecrets(values: string[]): void {
  // 太短的值打码会误伤正常文字，所以 6 位以下的不处理。程序本身不会把口令写进日志，这里只是兜底
  secrets = values.filter(v => v.length >= 6).sort((a, b) => b.length - a.length)
}

/** 开启写文件。不调用时只输出到标准输出（例如单元测试）。 */
export function enableFileLog(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logDir = dir
  currentDay = ''
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('***')
  return out
}

function pruneOldFiles(dir: string, today: string): void {
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - KEEP_DAYS * 86_400_000
  for (const name of readdirSync(dir)) {
    const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
    if (m && new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        // 删除失败不影响主流程
      }
    }
  }
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ` ${extra.message}`
  try {
    return ` ${JSON.stringify(extra)}`
  } catch {
    return ` ${String(extra)}`
  }
}

function write(level: Level, message: string, extra?: unknown): void {
  const now = new Date()
  const line = redact(`${now.toISOString()} [${level.toUpperCase()}] ${message}${formatExtra(extra)}`)
  if (level === 'info') console.log(line)
  else console.error(line)

  if (!logDir) return
  const day = now.toISOString().slice(0, 10)
  try {
    if (day !== currentDay) {
      currentDay = day
      pruneOldFiles(logDir, day)
    }
    appendFileSync(join(logDir, `app-${day}.log`), `${line}\n`)
  } catch (e) {
    console.error(`写日志文件失败：${(e as Error).message}`)
  }
}

export const log = {
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra)
}

export type Logger = typeof log
