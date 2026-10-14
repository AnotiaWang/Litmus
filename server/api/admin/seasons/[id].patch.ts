/** 修改赛季名称 */
import { renameSeason } from '../../../lib/admin'
import { getRuntime } from '../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  const body = await readBody(event)
  return adminCall(() => renameSeason(getRuntime(), id, body?.name))
})
