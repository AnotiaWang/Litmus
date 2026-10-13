import { getRuntime } from '../../lib/runtime'

export default defineEventHandler((event) => {
  const decision = getRuntime().store.getDecision(getRouterParam(event, 'id') ?? '')
  if (!decision) throw createError({ statusCode: 404, statusMessage: 'Not Found', message: '没有这条决策记录' })
  return decision
})
