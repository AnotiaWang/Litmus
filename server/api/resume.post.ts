import { getRuntime } from '../lib/runtime'
import { statusView } from '../lib/views'

export default defineEventHandler(() => {
  const rt = getRuntime()
  rt.engine.resume()
  return statusView(rt)
})
