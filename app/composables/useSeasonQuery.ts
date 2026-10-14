/**
 * 正在查看的赛季：URL 里的 ?season=，方便分享链接；没有时为当前赛季（由接口决定）。
 */
export function useSeasonQuery() {
  const route = useRoute()
  const router = useRouter()
  return computed<number | undefined>({
    get: () => {
      const v = Number(route.query.season)
      return Number.isInteger(v) && v > 0 ? v : undefined
    },
    set: (v) => {
      router.replace({ query: { ...route.query, season: v === undefined ? undefined : String(v) } })
    }
  })
}
