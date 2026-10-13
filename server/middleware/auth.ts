/** /api/* 口令校验：要求请求头 Authorization: Bearer <ADMIN_TOKEN>，比较方式见 server/lib/auth.ts。 */
import { tokenMatches } from '../lib/auth'
import { getRuntime } from '../lib/runtime'

export default defineEventHandler((event) => {
  const path = event.path
  if (!path.startsWith('/api/')) return
  // Nuxt Icon 的图标数据接口，公开内容，浏览器加载图标时不带口令
  if (path.startsWith('/api/_nuxt_icon/')) return

  const header = getRequestHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (!match || !tokenMatches(match[1]!, getRuntime().env.adminToken)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: '口令错误或未提供' })
  }
})
