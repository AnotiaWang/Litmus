/**
 * 接口请求和访问权限。
 * - 口令保存在浏览器本地（localStorage），只有管理接口和关闭了公开浏览时才需要
 * - session 由服务端告诉前端：是否公开浏览、当前口令是否正确
 * - 带着口令的请求返回 401 说明口令失效：清掉口令，重新查询权限，页面会相应地显示登录框
 */
import { useLocalStorage } from '@vueuse/core'
import type { SessionResponse } from '#shared/types/api'

const token = useLocalStorage('litmus-admin-token', '')
/** 口令失效时的提示，显示在口令输入框上方 */
const authError = ref('')
const session = ref<SessionResponse | null>(null)

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const authHeaders = (t: string) => t ? { Authorization: `Bearer ${t}` } : undefined
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode

export function useApi() {
  async function loadSession(): Promise<SessionResponse> {
    const s = await $fetch<SessionResponse>('/api/session', { headers: authHeaders(token.value) })
    if (token.value && !s.admin) {
      token.value = ''
      authError.value = '口令错误或已失效，请重新输入'
    }
    session.value = s
    return s
  }

  async function request<T>(url: string, opts: { method?: Method, query?: Record<string, string | number | boolean | undefined>, body?: Record<string, unknown> } = {}): Promise<T> {
    try {
      return await $fetch<T>(url, { ...opts, headers: authHeaders(token.value) }) as T
    } catch (e) {
      if (statusOf(e) === 401) {
        if (token.value) {
          token.value = ''
          authError.value = '口令错误或已失效，请重新输入'
        }
        loadSession().catch(() => {})
      }
      throw e
    }
  }

  /** 先用这个口令查一次权限，正确才保存 */
  async function login(input: string): Promise<boolean> {
    const s = await $fetch<SessionResponse>('/api/session', { headers: authHeaders(input) })
    if (!s.admin) {
      authError.value = '口令不对，请重新输入'
      return false
    }
    token.value = input
    authError.value = ''
    session.value = s
    return true
  }

  function logout() {
    token.value = ''
    if (session.value) session.value = { ...session.value, admin: false }
  }

  /** 能不能看公开页面：开启了公开浏览，或者带着正确的口令 */
  const canRead = computed(() => !!session.value && (session.value.publicRead || session.value.admin))
  const isAdmin = computed(() => session.value?.admin === true)

  return { token, authError, session, canRead, isAdmin, loadSession, request, login, logout }
}
