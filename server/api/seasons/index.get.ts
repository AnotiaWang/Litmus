import { getRuntime } from '../../lib/runtime'
import { seasonSummary } from '../../lib/views'

export default defineEventHandler(() => getRuntime().store.listSeasons().map(seasonSummary))
