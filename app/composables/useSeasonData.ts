/**
 * 公开页面共用的数据：赛季列表、运行状态、排行榜和收益率曲线。
 * 切换赛季时清空旧数据（显示骨架屏），慢的旧请求晚回来也不会覆盖新赛季的数据。
 */
import type { EquityResponse, SeasonSummary, StandingsResponse, StatusResponse } from '#shared/types/api'

export function useSeasonData(seasonId: Ref<number | undefined>) {
  const { request } = useApi()
  const toast = useToast()

  const seasons = ref<SeasonSummary[]>([])
  const status = ref<StatusResponse | null>(null)
  const standings = ref<StandingsResponse | null>(null)
  const equity = ref<EquityResponse | null>(null)
  const days = ref(30)
  const error = ref('')
  const refreshing = ref(false)
  const lastUpdated = ref<Date | null>(null)

  const season = computed(() => standings.value?.season ?? null)
  const agents = computed(() => new Map(standings.value?.standings.map(s => [s.agent.id, s.agent]) ?? []))
  /** 赛季里是否已经运行过 */
  const hasHistory = computed(() => standings.value?.asOf != null)

  /** 每次切换赛季加一，请求回来时对不上就丢掉 */
  let generation = 0

  async function loadEquity() {
    const gen = generation
    const data = await request<EquityResponse>('/api/equity', { query: { season: seasonId.value, days: days.value } })
    if (gen === generation) equity.value = data
  }

  async function refresh() {
    const gen = generation
    refreshing.value = true
    try {
      const [s, st, sd] = await Promise.all([
        request<SeasonSummary[]>('/api/seasons'),
        request<StatusResponse>('/api/status'),
        request<StandingsResponse>('/api/standings', { query: { season: seasonId.value } }),
        loadEquity()
      ])
      if (gen !== generation) return
      seasons.value = s
      status.value = st
      standings.value = sd
      error.value = ''
      lastUpdated.value = new Date()
    } catch (e) {
      if (gen === generation) error.value = errorMessage(e)
    } finally {
      refreshing.value = false
    }
  }

  watch(seasonId, () => {
    generation++
    standings.value = null
    equity.value = null
    refresh()
  })
  watch(days, () => loadEquity().catch((e) => {
    toast.add({ title: '加载收益率曲线失败', description: errorMessage(e), color: 'error' })
  }))

  return { seasons, status, standings, equity, days, error, refreshing, lastUpdated, season, agents, hasHistory, refresh }
}
