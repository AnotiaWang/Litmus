/** 修改 Provider。apiKey 留空表示不改 */
import { updateProvider } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  const body = await readBody(event)
  return adminCall(() => updateProvider(getRuntime(), id, body))
})
