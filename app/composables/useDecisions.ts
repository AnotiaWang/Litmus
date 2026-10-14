/**
 * 决策记录的分页列表。自动刷新时：在第 1 页就替换列表；不在第 1 页时不替换
 * （否则新记录会把正在看的行挤走），只数一下新增了几条。
 */
import type { DecisionsResponse } from '#shared/types/api'

export function useDecisions(opts: { seasonId: Ref<number | undefined>, agentId?: Ref<number | undefined>, pageSize: number, onlyActions?: boolean }) {
  const { request } = useApi()
  const toast = useToast()

  const data = ref<DecisionsResponse>({ items: [], total: 0 })
  const page = ref(1)
  const onlyActions = ref(opts.onlyActions ?? false)
  const loading = ref(false)
  const loaded = ref(false)
  const newCount = ref(0)

  const query = () => ({ season: opts.seasonId.value, agent: opts.agentId?.value, only_actions: onlyActions.value })

  /** silent：后台自动刷新时不显示表格的加载条，避免每 30 秒闪一下 */
  async function load({ silent = false } = {}) {
    if (!silent) loading.value = true
    try {
      data.value = await request<DecisionsResponse>('/api/decisions', {
        query: { ...query(), limit: opts.pageSize, offset: (page.value - 1) * opts.pageSize }
      })
      loaded.value = true
      newCount.value = 0
    } finally {
      loading.value = false
    }
  }

  async function refresh() {
    if (page.value === 1) {
      await load({ silent: true })
    } else {
      const { total } = await request<DecisionsResponse>('/api/decisions', { query: { ...query(), limit: 1, offset: 0 } })
      newCount.value = Math.max(0, total - data.value.total)
    }
  }

  const reload = () => load().catch((e) => {
    toast.add({ title: '加载决策记录失败', description: errorMessage(e), color: 'error' })
  })

  watch(onlyActions, () => {
    page.value = 1
  })
  watch([page, onlyActions], reload)
  watch([opts.seasonId, () => opts.agentId?.value], () => {
    loaded.value = false
    if (page.value === 1) reload()
    else page.value = 1
  })

  return { data, page, onlyActions, loading, loaded, newCount, load, refresh }
}
