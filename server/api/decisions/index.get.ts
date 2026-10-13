import { z } from 'zod'
import { getRuntime } from '../../lib/runtime'
import { decisionSummary } from '../../lib/views'

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  only_actions: z.enum(['true', 'false', '1', '0']).default('false').transform(v => v === 'true' || v === '1')
})

export default defineEventHandler(async (event) => {
  const q = await getValidatedQuery(event, query.parse)
  const { items, total } = getRuntime().store.listDecisions({ limit: q.limit, offset: q.offset, onlyActions: q.only_actions })
  return { items: items.map(decisionSummary), total }
})
