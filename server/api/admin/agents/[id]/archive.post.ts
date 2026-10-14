/** 归档模型：停止参赛，保留成绩 */
import { archiveAgent } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  return adminCall(() => archiveAgent(getRuntime(), id))
})
