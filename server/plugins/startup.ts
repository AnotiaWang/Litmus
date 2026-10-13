/**
 * 启动插件：
 * 1. 读取并校验配置，不合法直接退出（宁可起不来，也不带着错误配置运行）
 * 2. SELFCHECK=1 时只跑自检，然后退出
 * 3. BACKTEST=1 时只跑回测，然后退出（只读取正式数据库里的设置，不写入）
 * 4. 否则按面板里设置的运行间隔，在整点对齐的时刻（如 :00、:15、:30、:45）触发 trade:run；
 *    面板里改了间隔会马上按新间隔重新排定
 *
 * 不用 Nitro 的 scheduledTasks：它的 cron 表达式在构建时写死，没法在运行中修改间隔。
 */
import { join } from 'node:path'
import { settingsSchema } from '../../shared/settings'
import { parseBacktestDays, runBacktestCommand } from '../lib/backtest'
import { ConfigError, legacyEnvKeys, loadEnvConfig, resolveConfig, secretsOf, settingsFromEnv } from '../lib/config'
import { readStoredSettings } from '../lib/db'
import { log, setSecrets } from '../lib/logger'
import { getRuntime, type Runtime } from '../lib/runtime'
import { runSelfcheck } from '../lib/selfcheck'

export default defineNitroPlugin((nitroApp) => {
  if (process.env.BACKTEST === '1') {
    try {
      const env = loadEnvConfig()
      setSecrets(secretsOf(env))
      // 用面板里当前的设置回测；命令行用 -e 临时传入的旧变量名（如 SIGNAL_MODE=cross）覆盖在上面，只对这次回测生效
      const stored = readStoredSettings(join(env.dataDir, 'litmus.db')) ?? {}
      // .env 里没删掉的旧变量也会被当成临时参数，打印出来免得误以为用的是面板设置
      const legacy = legacyEnvKeys()
      if (legacy.length) console.log(`用环境变量临时覆盖面板设置：${legacy.map(k => `${k}=${process.env[k]!.trim()}`).join('，')}`)
      const parsed = settingsSchema.safeParse({ ...stored, ...settingsFromEnv() })
      if (!parsed.success) throw new ConfigError(`回测参数不合法：${parsed.error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('；')}`)
      const config = resolveConfig(env, parsed.data)
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
    runSelfcheck({ ...rt, config: rt.config() })
      .then(ok => process.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error('自检异常：', e)
        process.exit(1)
      })
    return
  }

  const interrupted = rt.store.markInterrupted()
  if (interrupted) log.warn(`发现 ${interrupted} 条上次未跑完的决策，已标记为中断`)
  const legacy = legacyEnvKeys()
  if (legacy.length) log.warn(`这些环境变量已改为在面板「设置」里调整，.env 里的值不再生效，可以删掉：${legacy.join('、')}`)

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopping = false

  const scheduleNext = () => {
    if (stopping) return
    // 每次都读最新的设置，面板里改了间隔，下一次排定就会用上
    const intervalMs = rt.config().intervalMinutes * 60_000
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
  // 面板里改了运行间隔：取消已排定的这次，按新间隔重新排。正在运行的一轮不受影响，跑完后会按新间隔继续
  rt.reschedule = () => {
    if (!timer || stopping) return
    clearTimeout(timer)
    scheduleNext()
    log.info(`运行间隔已改为每 ${rt.config().intervalMinutes} 分钟，下次 ${rt.nextRunAt}`)
  }
  log.info(`服务已启动：${rt.env.binance.env === 'demo' ? 'Demo Mode' : '测试网'}，${rt.env.symbol}，每 ${rt.config().intervalMinutes} 分钟运行一次，下次 ${rt.nextRunAt}`)

  // 进程退出前等当前这一轮跑完，避免下单后来不及记账
  nitroApp.hooks.hook('close', async () => {
    stopping = true
    if (timer) clearTimeout(timer)
    if (rt.engine.isRunning) log.info('等待当前这一轮决策结束后退出…')
    await rt.engine.waitIdle()
    rt.store.close()
  })
})
