import { createProvider } from '../../../lib/admin'
import { getRuntime } from '../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return adminCall(() => createProvider(getRuntime(), body))
})
