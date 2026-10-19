/** 暂停模型：停止参赛，保留账本和历史记录，可以恢复 */
import { pauseAgent } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  return adminCall(() => pauseAgent(getRuntime(), id))
})
