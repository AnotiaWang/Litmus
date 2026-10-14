import type { AdminSettingsResponse } from '../../../shared/types/api'
import { getRuntime } from '../../lib/runtime'

export default defineEventHandler((): AdminSettingsResponse => ({ app: getRuntime().store.getAppSettings() }))
