/** 暂停：所有模型不再询问 LLM、不交易，资产照常记录 */
import { getRuntime } from '../../lib/runtime'
import { statusView } from '../../lib/views'

export default defineEventHandler(() => {
  const rt = getRuntime()
  rt.engine.pause()
  return statusView(rt)
})
