import { getRuntime } from '../lib/runtime'
import { settingsView } from '../lib/settings'

export default defineEventHandler(() => settingsView(getRuntime()))
