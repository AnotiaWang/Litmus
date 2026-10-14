/** 决策记录。?season= 指定赛季（默认当前赛季），?agent= 只看某个模型，?only_actions= 只看买卖 */
import { z } from 'zod'
import { getRuntime } from '../../lib/runtime'

const query = z.object({
  agent: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  only_actions: z.enum(['true', 'false', '1', '0']).default('false').transform(v => v === 'true' || v === '1')
})

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, query.parse)
  const season = await seasonFromQuery(event)
  return getRuntime().store.listDecisions({ seasonId: season.id, agentId: q.agent, onlyActions: q.only_actions, limit: q.limit, offset: q.offset })
})
