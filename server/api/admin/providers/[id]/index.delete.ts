import { deleteProvider } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  await adminCall(() => deleteProvider(getRuntime(), id))
  return { ok: true }
})
