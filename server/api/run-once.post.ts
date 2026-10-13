/** 立即执行一轮。暂停状态下也会运行，但只记录信号、不下单。 */
import type { RunResult } from '../../shared/types/api'

export default defineEventHandler(async () => {
  const { result } = await runTask('trade:run', { payload: { trigger: 'manual' } }) as { result: RunResult }
  return result
})
