import { listAgentsAdmin } from '../../../lib/admin'
import { getRuntime } from '../../../lib/runtime'

export default defineEventHandler(() => listAgentsAdmin(getRuntime().store))
