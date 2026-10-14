/**
 * /api/* 访问控制：
 * - /api/admin/* 和所有写操作始终需要口令（Authorization: Bearer <ADMIN_TOKEN>）
 * - 其余只读接口：开启公开浏览时任何人都能访问，关闭时也需要口令
 * - /api/session 始终可以访问，前端用它判断显示登录框还是公开页面
 */
import { isAdminHeader } from '../lib/auth'
import { getRuntime } from '../lib/runtime'

export default defineEventHandler((event) => {
  const path = event.path.split('?')[0]!
  if (!path.startsWith('/api/')) return
  // Nuxt Icon 的图标数据接口，公开内容，浏览器加载图标时不带口令
  if (path.startsWith('/api/_nuxt_icon/')) return

  const rt = getRuntime()
  const admin = isAdminHeader(getRequestHeader(event, 'authorization'), rt.env.adminToken)
  event.context.admin = admin
  if (admin || path === '/api/session') return
  const readOnly = event.method === 'GET' && !path.startsWith('/api/admin/')
  if (readOnly && rt.store.getAppSettings().publicRead) return
  throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: '口令错误或未提供' })
})
