/** 测试模型：用当前行情问一次，不记录、不交易 */
import { testAgent } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  return adminCall(() => testAgent(getRuntime(), id))
})
