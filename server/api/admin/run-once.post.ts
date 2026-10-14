/** 立即运行一轮：所有参赛模型都会马上问一次 LLM（不受“每根 K 线问一次”的限制），注意调用成本。 */
import type { RunResult } from '../../../shared/types/api'

export default defineEventHandler(async () => {
  const { result } = await runTask('trade:run', { payload: { trigger: 'manual' } }) as { result: RunResult }
  return result
})
