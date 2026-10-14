/** 接口层共用的小工具（Nitro 自动导入）。 */
import { z } from 'zod'
import type { H3Event } from 'h3'
import { AdminError } from '../lib/admin'
import type { SeasonRow } from '../lib/db'
import { getRuntime } from '../lib/runtime'

/** 管理操作出错（AdminError）时按它的状态码返回，其他错误照常抛出 */
export async function adminCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof AdminError) throw createError({ statusCode: e.statusCode, message: e.message })
    throw e
  }
}

/** 路由参数里的数字 ID */
export function idParam(event: H3Event): number {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, message: 'ID 不合法' })
  return id
}

const seasonQuery = z.object({ season: z.coerce.number().int().positive().optional() })

/** 查询参数 season 指定的赛季，不传时为当前赛季 */
export async function seasonFromQuery(event: H3Event): Promise<SeasonRow> {
  const { season } = await getValidatedQuery(event, seasonQuery.parse)
  const { store } = getRuntime()
  const row = season === undefined ? store.currentSeason() ?? store.listSeasons()[0] : store.getSeason(season)
  if (!row) throw createError({ statusCode: 404, message: '赛季不存在' })
  return row
}
