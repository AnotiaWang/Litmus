/**
 * 带口令的接口请求。口令保存在浏览器本地（localStorage），
 * 接口返回 401 时清掉口令，页面会重新显示输入框。
 */
import { useLocalStorage } from '@vueuse/core'

const token = useLocalStorage('litmus-admin-token', '')
/** 口令失效时的提示，显示在口令输入框上方 */
const authError = ref('')

export function useApi() {
  async function request<T>(url: string, opts: { method?: 'GET' | 'POST' | 'PUT', query?: Record<string, string | number | boolean>, body?: Record<string, unknown> } = {}): Promise<T> {
    try {
      return await $fetch<T>(url, { ...opts, headers: { Authorization: `Bearer ${token.value}` } }) as T
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 401) {
        token.value = ''
        authError.value = '口令错误或已失效，请重新输入'
      }
      throw e
    }
  }

  return { token, authError, request }
}
