/** 开始新赛季：body { name?, config }。结束当前赛季，所有参赛中的模型从初始资金重新开始 */
import { startSeason } from '../../../lib/admin'
import { getRuntime } from '../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return adminCall(() => startSeason(getRuntime(), { name: body?.name, config: body?.config }))
})
