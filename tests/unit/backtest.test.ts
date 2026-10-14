/** 回测：用合成的历史 K 线跑真实引擎，不访问网络 */
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchHistory, formatReport, parseBacktestDays, readCurrentSeasonConfig, runBacktest } from '../../server/lib/backtest'
import { Store } from '../../server/lib/db'
import { MockMarket, type Kline } from '../../server/lib/market'
import { makeKlines, NOW, testSeasonConfig } from './helpers'

const END = Date.UTC(2026, 9, 1)

/** 横盘 120 根 → 上涨 80 根 → 下跌 80 根，叠加交替波动让 RSI 保持在正常区间 */
function cycleCloses(): number[] {
  const closes: number[] = []
  let p = 50000
  for (let i = 0; i < 120; i++) closes.push(p)
  for (let i = 0; i < 80; i++) closes.push(p += 100)
  for (let i = 0; i < 80; i++) closes.push(p -= 150)
  return closes.map((c, i) => c + (i % 2 ? 300 : -300))
}

const rules = new MockMarket().rules

describe('回测', () => {
  it('一轮涨跌里完成买入和卖出，统计结果和资产快照一致', async () => {
    const config = testSeasonConfig({ initialCapital: '1000' })
    const report = await runBacktest({ config, klines: makeKlines(cycleCloses(), END), rules })
    expect(report.candles).toBe(180)
    expect(report.trades.length).toBeGreaterThanOrEqual(2)
    expect(report.trades[0]!.side).toBe('buy')
    expect(report.trades.some(t => t.side === 'sell')).toBe(true)
    expect(report.sells).toBeGreaterThanOrEqual(1)
    expect(report.wins).toBeLessThanOrEqual(report.sells)
    expect(report.outcomes.filled).toBe(report.trades.length)
    expect(Number(report.fees)).toBeGreaterThan(0)
    expect(Number(report.maxDrawdownPct)).toBeGreaterThanOrEqual(0)
    // 收益率由期末资产算出
    expect(new Decimal(report.finalEquity).minus(1000).div(10).toFixed(2)).toBe(report.returnPct)

    const text = formatReport(config, report).join('\n')
    expect(text).toContain('收益率')
    expect(text).toContain('SMA20/50 连续 2 根确认')
    expect(text).toContain('同期一直持有')
    expect(text).toContain('买入')
  })

  it('K 线不足时报错', async () => {
    await expect(runBacktest({ config: testSeasonConfig(), klines: makeKlines(cycleCloses().slice(0, 100), END), rules })).rejects.toThrow(/K 线不足/)
  })

  it('分页拉取历史 K 线，去掉未收盘的', async () => {
    const all = makeKlines(Array.from({ length: 2500 }, (_, i) => 50000 + i), END)
    const calls: number[] = []
    const source = {
      async getKlines(_s: string, _i: string, limit: number, range: { startTime?: number, endTime?: number }): Promise<Kline[]> {
        calls.push(range.startTime!)
        return all.filter(k => k.openTime >= range.startTime! && k.openTime < range.endTime!).slice(0, limit)
      }
    }
    // endTime 落在最后一根 K 线中间：最后一根还没收盘
    const got = await fetchHistory(source, 'BTCUSDT', '1h', all[0]!.openTime, all.at(-1)!.openTime + 1000)
    expect(calls).toHaveLength(3)
    expect(got).toHaveLength(2499)
    expect(new Set(got.map(k => k.openTime)).size).toBe(2499)
  })

  it('回测天数默认 90，范围 1~1000', () => {
    expect(parseBacktestDays(undefined)).toBe(90)
    expect(parseBacktestDays('')).toBe(90)
    expect(parseBacktestDays('30')).toBe(30)
    expect(() => parseBacktestDays('0')).toThrow(/BACKTEST_DAYS/)
    expect(() => parseBacktestDays('abc')).toThrow(/BACKTEST_DAYS/)
  })

  it('读取正式数据库里当前赛季的配置（只读）；数据库不存在时返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'litmus-bt-'))
    expect(readCurrentSeasonConfig(join(dir, 'none.db'))).toBeNull()
    const path = join(dir, 'litmus.db')
    const store = new Store(path)
    store.startSeason('第 1 赛季', testSeasonConfig({ klineInterval: '4h' }), NOW)
    store.close()
    expect(readCurrentSeasonConfig(path)).toMatchObject({ klineInterval: '4h', initialCapital: '100' })
  })
})
