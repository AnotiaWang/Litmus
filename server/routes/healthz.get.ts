/** 健康检查（无需口令）：进程存活且数据库可读即返回 ok。 */
import { getRuntime } from '../lib/runtime'

export default defineEventHandler(() => {
  getRuntime().store.db.prepare('SELECT 1').get()
  return { ok: true }
})
