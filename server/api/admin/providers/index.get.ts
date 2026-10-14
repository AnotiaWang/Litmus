import { listProvidersView } from '../../../lib/admin'
import { getRuntime } from '../../../lib/runtime'

export default defineEventHandler(() => listProvidersView(getRuntime().store))
