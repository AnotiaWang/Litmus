/** 修改站点设置（公开浏览开关等） */
import type { AdminSettingsResponse } from '../../../shared/types/api'
import { updateAppSettings } from '../../lib/admin'
import { getRuntime } from '../../lib/runtime'

export default defineEventHandler(async (event): Promise<AdminSettingsResponse> => {
  const body = await readBody(event)
  return { app: await adminCall(() => updateAppSettings(getRuntime(), body?.app)) }
})
