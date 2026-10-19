/** 当前赛季的 LLM 健康统计：成功率、重试、429/超时、耗时和估算成本 */
import { getRuntime } from '../../lib/runtime'
import { healthView } from '../../lib/views'

export default defineEventHandler(async (event) => {
  const season = await seasonFromQuery(event)
  return healthView(getRuntime().store, season)
})
