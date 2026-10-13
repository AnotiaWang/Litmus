import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tokenMatches } from '../../server/lib/auth'
import { enableFileLog, log, redact, setSecrets } from '../../server/lib/logger'

describe('日志', () => {
  afterEach(() => {
    setSecrets([])
    vi.restoreAllMocks()
  })

  it('登记过的 Key 在日志里被打码', () => {
    setSecrets(['super-secret-key-123'])
    expect(redact('error: key=super-secret-key-123 failed')).toBe('error: key=*** failed')
  })

  it('写入按日期命名的文件，删除 14 天前的旧文件，输出已脱敏', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'litmus-log-'))
    writeFileSync(join(dir, 'app-2000-01-01.log'), 'old')
    writeFileSync(join(dir, 'other.txt'), 'keep')
    setSecrets(['super-secret-key-123'])
    enableFileLog(dir)
    log.info('hello', { token: 'super-secret-key-123' })
    const today = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(dir, `app-${today}.log`), 'utf8')
    expect(content).toContain('hello')
    expect(content).toContain('***')
    expect(content).not.toContain('super-secret-key-123')
    expect(existsSync(join(dir, 'app-2000-01-01.log'))).toBe(false)
    expect(existsSync(join(dir, 'other.txt'))).toBe(true)
  })
})

describe('口令比较', () => {
  it('相同为真，不同或长度不同为假且不抛错', () => {
    expect(tokenMatches('admin-token-0123456789', 'admin-token-0123456789')).toBe(true)
    expect(tokenMatches('admin-token-0123456788', 'admin-token-0123456789')).toBe(false)
    expect(tokenMatches('', 'admin-token-0123456789')).toBe(false)
    expect(tokenMatches('x'.repeat(1000), 'admin-token-0123456789')).toBe(false)
  })
})
