/** 删除模型：只能删还没参与过运行的，参与过的只能归档 */
import { deleteAgent } from '../../../../lib/admin'
import { getRuntime } from '../../../../lib/runtime'

export default defineEventHandler(async (event) => {
  const id = idParam(event)
  await adminCall(() => deleteAgent(getRuntime(), id))
  return { ok: true }
})
