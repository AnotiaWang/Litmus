/** 新建模型，自动加入当前赛季，从下一轮开始参赛 */
import { createAgent } from '../../../lib/admin'
import { getRuntime } from '../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return adminCall(() => createAgent(getRuntime(), body))
})
