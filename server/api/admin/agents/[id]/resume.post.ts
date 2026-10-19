/** 恢复模型：从下一轮开始继续参赛 */
import { resumeAgent } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  return adminCall(() => resumeAgent(getRuntime(), id))
})
