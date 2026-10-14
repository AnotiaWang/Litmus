/** 当前访问者的权限：是否公开浏览、是否带了正确的口令。始终可以访问。 */
import type { SessionResponse } from '../../shared/types/api'
import { getRuntime } from '../lib/runtime'

export default defineEventHandler((event): SessionResponse => ({
  publicRead: getRuntime().store.getAppSettings().publicRead,
  admin: event.context.admin === true
}))
