import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'

/** 定时刷新：页面切到后台时暂停，切回来立刻刷新一次 */
export function usePolling(fn: () => unknown, ms: number) {
  const timer = useIntervalFn(fn, ms)
  const visibility = useDocumentVisibility()
  watch(visibility, (v) => {
    if (v === 'hidden') {
      timer.pause()
    } else {
      fn()
      timer.resume()
    }
  })
}
