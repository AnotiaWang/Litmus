/**
 * 启动插件：
 * 1. 读取并校验配置，不合法直接退出（宁可起不来，也不带着错误配置运行）
 * 2. SELFCHECK=1 时只跑自检，然后退出
 * 3. BACKTEST=1 时只跑回测，然后退出（只读取正式数据库里当前赛季的配置，不写入）
 * 4. 否则按当前赛季的运行间隔，在整点对齐的时刻（如 :00、:15、:30、:45）触发 trade:run；
 *    开始新赛季后马上按新间隔重新排定
 *
 * 不用 Nitro 的 scheduledTasks：它的 cron 表达式在构建时写死，没法在运行中修改间隔。
 */
import { join } from 'node:path'
import { DEFAULT_SEASON_CONFIG } from '../../shared/settings'
import { parseBacktestDays, readCurrentSeasonConfig, runBacktestCommand } from '../lib/backtest'
import { ConfigError, legacyEnvKeys, loadEnvConfig } from '../lib/config'
import { log } from '../lib/logger'
import { getRuntime, type Runtime } from '../lib/runtime'
import { runSelfcheck } from '../lib/selfcheck'

export default defineNitroPlugin((nitroApp) => {
  if (process.env.BACKTEST === '1') {
    try {
      const env = loadEnvConfig()
      const config = readCurrentSeasonConfig(join(env.dataDir, 'litmus.db')) ?? DEFAULT_SEASON_CONFIG
      runBacktestCommand(config, parseBacktestDays(process.env.BACKTEST_DAYS), line => console.log(line))
        .then(ok => process.exit(ok ? 0 : 1))
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    }
    return
  }

  let rt: Runtime
  try {
    rt = getRuntime()
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e)
    process.exit(1)
  }

  if (process.env.SELFCHECK === '1') {
    runSelfcheck(rt)
      .then(ok => process.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error('自检异常：', e)
        process.exit(1)
      })
    return
  }

  const legacy = legacyEnvKeys()
  if (legacy.length) log.warn(`这些环境变量已不再使用，可以从 .env 里删掉：${legacy.join('、')}。Provider、模型和赛季参数都在面板「管理」里设置`)

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopping = false
  const intervalMinutes = () => rt.store.currentSeason()?.config.checkIntervalMinutes ?? DEFAULT_SEASON_CONFIG.checkIntervalMinutes

  const scheduleNext = () => {
    if (stopping) return
    // 每次都读当前赛季的间隔，开始新赛季后下一次排定就会用上
    const intervalMs = intervalMinutes() * 60_000
    const now = Date.now()
    const next = Math.floor(now / intervalMs) * intervalMs + intervalMs
    rt.nextRunAt = new Date(next).toISOString()
    timer = setTimeout(async () => {
      // 这一轮跑完会自己排下一次；期间 reschedule 看到 timer 为空就不再重复排
      timer = null
      try {
        await runTask('trade:run', { payload: { trigger: 'schedule' } })
      } catch (e) {
        log.error('定时任务执行失败', e)
      }
      scheduleNext()
    }, next - now)
  }
  scheduleNext()
  // 开始了新赛季：取消已排定的这次，按新间隔重新排。正在运行的一轮不受影响，跑完后会按新间隔继续
  rt.reschedule = () => {
    if (!timer || stopping) return
    clearTimeout(timer)
    scheduleNext()
    log.info(`运行间隔：每 ${intervalMinutes()} 分钟，下次 ${rt.nextRunAt}`)
  }
  const season = rt.store.currentSeason()
  log.info(`服务已启动：${season ? `${season.name}，${season.config.symbol}，` : ''}每 ${intervalMinutes()} 分钟运行一次，下次 ${rt.nextRunAt}`)

  // 进程退出前等当前这一轮跑完，避免成交后来不及记账
  nitroApp.hooks.hook('close', async () => {
    stopping = true
    if (timer) clearTimeout(timer)
    if (rt.engine.isRunning) log.info('等待当前这一轮结束后退出…')
    await rt.engine.waitIdle()
    rt.store.close()
  })
})
