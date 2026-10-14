/** 赛季排行榜。?season= 指定赛季，不传时为当前赛季 */
import { getRuntime } from '../lib/runtime'
import { standingsView } from '../lib/views'

export default defineEventHandler(async event => standingsView(getRuntime().store, await seasonFromQuery(event)))
