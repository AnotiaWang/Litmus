/** 修改模型：只能改显示名、颜色和超时 */
import { updateAgent } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  const body = await readBody(event)
  return adminCall(() => updateAgent(getRuntime(), id, body))
})
