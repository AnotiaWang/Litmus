/** Provider 提供的模型列表（转发 GET /models），新建模型时选择用 */
import { providerModels } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  return adminCall(() => providerModels(getRuntime(), id))
})
