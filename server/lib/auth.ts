/**
 * 口令比较：先对两边做 SHA-256，得到等长的摘要再用 timingSafeEqual 比较。
 * 这样耗时与口令内容无关（防计时攻击），长度不同时也不会抛错。
 */
import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (s: string) => createHash('sha256').update(s).digest()

export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected))
}
