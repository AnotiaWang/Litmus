import { getRuntime } from '../lib/runtime'
import { accountView } from '../lib/views'

export default defineEventHandler(() => accountView(getRuntime()))
