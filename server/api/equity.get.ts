/** 资产曲线。?season= 指定赛季（默认当前赛季），?days= 最近多少天 */
import { z } from 'zod'
import { getRuntime } from '../lib/runtime'
import { equityView } from '../lib/views'

const query = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(30)
})

export default defineEventHandler(async (event) => {
  const { days } = await getValidatedQuery(event, query.parse)
  return equityView(getRuntime().store, await seasonFromQuery(event), days)
})
