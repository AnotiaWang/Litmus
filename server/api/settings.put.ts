/** 保存面板里的设置，返回保存后的完整设置。改预算会重新开始策略账本，限制见 server/lib/settings.ts。 */
import { getRuntime } from '../lib/runtime'
import { SettingsError, settingsView, updateSettings } from '../lib/settings'

export default defineEventHandler(async (event) => {
  const rt = getRuntime()
  try {
    await updateSettings(rt, await readBody(event))
  } catch (e) {
    if (e instanceof SettingsError) throw createError({ statusCode: e.statusCode, message: e.message })
    throw e
  }
  return settingsView(rt)
})
