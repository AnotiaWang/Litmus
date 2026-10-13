/**
 * Nitro 任务 trade:run：执行一轮交易决策。
 * 定时触发和 /api/run-once 都走这里；开发时也可以用 `nuxt task run trade:run` 手动触发。
 */
import { getRuntime } from '../../lib/runtime'

export default defineTask({
  meta: {
    name: 'trade:run',
    description: '执行一轮交易决策'
  },
  async run({ payload }) {
    const trigger = payload.trigger === 'schedule' ? 'schedule' : 'manual'
    const result = await getRuntime().engine.runOnce(trigger)
    return { result }
  }
})
