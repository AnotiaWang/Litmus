import { getRuntime } from '../lib/runtime'
import { statusView } from '../lib/views'

export default defineEventHandler(() => statusView(getRuntime()))
