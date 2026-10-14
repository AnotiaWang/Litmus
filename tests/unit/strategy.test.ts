import { describe, expect, it } from 'vitest'
import { atr, BASELINE_PARAMS, closedKlines, evaluate, marketStats, rsi, sma, stopLine, streak, type PositionContext } from '../../server/lib/strategy'
import { deathCrossCloses, downtrendCloses, flatCloses, goldenCrossCloses, hotGoldenCrossCloses, makeKlines, steadyRiseCloses, STRATEGY_FIXTURE, uptrendCloses } from './helpers'

const params = STRATEGY_FIXTURE

describe('指标计算', () => {
  it('SMA 取最近 N 个值的平均', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4)
    expect(sma([1, 2], 3)).toBeNaN()
  })

  // StockCharts ChartSchool 的 RSI 示例数据（14 周期，Wilder 平滑）
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
    46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
    43.42, 42.66, 43.13
  ]
  const expected = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77]

  // StockCharts 的表格把首个平均涨跌幅四舍五入到两位小数后再往下算，所以结果有不到 0.1 的偏差
  it('RSI 与 StockCharts 示例数值一致（误差 < 0.1）', () => {
    expected.forEach((value, i) => {
      expect(Math.abs(rsi(closes.slice(0, 15 + i), 14) - value)).toBeLessThan(0.1)
    })
  })

  it('RSI 边界情况', () => {
    expect(rsi([1, 2, 3], 14)).toBeNaN()
    expect(rsi(Array.from({ length: 20 }, (_, i) => i), 14)).toBe(100)
    expect(rsi(Array.from({ length: 20 }, () => 5), 14)).toBe(50)
  })
})

describe('行情摘要', () => {
  it('ATR：每根波幅都是 2 时 ATR 为 2；数据不足时为 NaN', () => {
    const klines = makeKlines(Array.from({ length: 20 }, () => 100), Date.UTC(2026, 9, 8))
    expect(atr(klines, 14)).toBeCloseTo(2)
    expect(atr(klines.slice(0, 14), 14)).toBeNaN()
  })

  it('统计最近 24 小时的涨跌、高低、离高低点的距离、更短时段的涨跌和成交量倍数；K 线不够 24 小时时取全部', () => {
    const klines = makeKlines(Array.from({ length: 30 }, (_, i) => 100 + i), Date.UTC(2026, 9, 8))
    klines.at(-1)!.volume = '3'
    const s = marketStats(klines)
    expect(s.hours).toBe(24)
    expect(s.changePct).toBeCloseTo((129 - 106) / 106 * 100)
    expect(s.high).toBeCloseTo(129 * 1.01)
    expect(s.low).toBeCloseTo(106 * 0.99)
    expect(s.volumeRatio).toBe(3)
    expect(s.changes.map(c => c.hours)).toEqual([1, 4, 12])
    expect(s.changes[0]!.pct).toBeCloseTo(0)
    expect(s.changes[1]!.pct).toBeCloseTo((129 - 126) / 126 * 100)
    expect(s.changes[2]!.pct).toBeCloseTo((129 - 118) / 118 * 100)
    expect(s.fromHighPct).toBeCloseTo((129 - 129 * 1.01) / (129 * 1.01) * 100)
    expect(s.fromLowPct).toBeCloseTo((129 - 106 * 0.99) / (106 * 0.99) * 100)

    const short = marketStats(klines.slice(0, 10))
    expect(short.hours).toBe(10)
    expect(short.volumeRatio).toBeNaN()
    // 12 小时超出了统计区间
    expect(short.changes.map(c => c.hours)).toEqual([1, 4])
  })
})

describe('规则信号', () => {
  const end = Date.UTC(2026, 9, 8, 12)
  const cross = { ...params, mode: 'cross' as const }
  const flat: PositionContext = { hasPosition: false, price: 50000, entryPrice: null, peakPrice: null, reentryLocked: false }
  const holding = (overrides: Partial<PositionContext> = {}): PositionContext =>
    ({ hasPosition: true, price: 50000, entryPrice: 49000, peakPrice: 50000, reentryLocked: false, ...overrides })
  const k = (closes: number[]) => makeKlines(closes, end)

  it('只保留已收盘的 K 线', () => {
    const klines = makeKlines([1, 2, 3], end)
    expect(closedKlines(klines, end - 1)).toHaveLength(2)
    expect(closedKlines(klines, end)).toHaveLength(3)
  })

  it('K 线不足时报错', () => {
    expect(() => evaluate(k(flatCloses().slice(0, 50)), params, flat)).toThrow(/K 线数量不足/)
  })

  describe('trend 模式（默认）', () => {
    it('空仓、短期均线在上方且 RSI < 70 时买入', () => {
      const r = evaluate(k(goldenCrossCloses()), params, flat)
      expect(r.indicators.smaFast).toBeGreaterThan(r.indicators.smaSlow)
      expect(r.indicators.rsi).toBeLessThan(70)
      expect(r).toMatchObject({ signal: 'buy', kind: 'trend_up' })
    })

    it('不要求恰好在交叉那根 K 线：稳定上涨中 RSI 回落后同样买入', () => {
      // 先涨，最后几根回调，让 RSI 落到 70 以下，均线仍在上方
      const closes = [...steadyRiseCloses().slice(0, 90), ...Array.from({ length: 10 }, (_, i) => 48900 - i * 60)]
      const r = evaluate(k(closes), params, flat)
      expect(r.indicators.prevSmaFast).toBeGreaterThan(r.indicators.prevSmaSlow)
      expect(r.signal).toBe('buy')
    })

    it('RSI 过热时等回落', () => {
      const r = evaluate(k(steadyRiseCloses()), params, flat)
      expect(r.signal).toBe('hold')
      expect(r.note).toContain('过热')
    })

    it('持仓时不加仓；短期均线跌到下方时卖出', () => {
      expect(evaluate(k(goldenCrossCloses()), params, holding()).signal).toBe('hold')
      expect(evaluate(k(deathCrossCloses()), params, holding({ price: 49000 }))).toMatchObject({ signal: 'sell', kind: 'trend_down' })
    })

    it('空仓时不产生卖出信号', () => {
      expect(evaluate(k(deathCrossCloses()), params, flat).signal).toBe('hold')
    })

    it('持仓且 RSI > 80 时止盈', () => {
      expect(evaluate(k(steadyRiseCloses()), params, holding({ price: 49900, peakPrice: 49900 }))).toMatchObject({ signal: 'sell', kind: 'take_profit' })
    })

    it('止损后锁定买入，直到短期均线回到下方', () => {
      const r = evaluate(k(goldenCrossCloses()), params, { ...flat, reentryLocked: true })
      expect(r.signal).toBe('hold')
      expect(r.note).toContain('卖出后等待趋势重新确认')
    })
  })

  describe('信号确认（trend 模式）', () => {
    const confirm2 = { ...params, confirmBars: 2 }
    /** 稳定上涨后小幅回调：均线已经在上方很多根，RSI 回落到 70 以下 */
    const upTrend = () => [...steadyRiseCloses().slice(0, 90), ...Array.from({ length: 10 }, (_, i) => 48900 - i * 60)]
    const downTrend = () => Array.from({ length: 100 }, (_, i) => 60000 - i * 100)

    it('streak：从最新一根往前数均线连续在上方 / 下方的根数', () => {
      expect(streak(goldenCrossCloses(), params, 1, 10)).toBe(1)
      expect(streak(goldenCrossCloses(), params, -1, 10)).toBe(0)
      expect(streak(upTrend(), params, 1, 5)).toBe(5)
      expect(streak(downTrend(), params, -1, 3)).toBe(3)
    })

    it('刚上穿 1 根时不买，注明还差几根；连续够了才买', () => {
      const r = evaluate(k(goldenCrossCloses()), confirm2, flat)
      expect(r.signal).toBe('hold')
      expect(r.note).toContain('上方 1 根，需连续 2 根才买入')
      expect(evaluate(k(upTrend()), confirm2, flat)).toMatchObject({ signal: 'buy', kind: 'trend_up' })
      expect(evaluate(k(upTrend()), confirm2, flat).note).toContain('连续 2 根在长期均线上方')
    })

    it('持仓时刚下穿 1 根不卖，连续够了才卖', () => {
      const r = evaluate(k(deathCrossCloses()), confirm2, holding({ price: 49000 }))
      expect(r.signal).toBe('hold')
      expect(r.note).toContain('下方 1 根，需连续 2 根才卖出')
      expect(evaluate(k(downTrend()), confirm2, holding({ price: 50100, entryPrice: 50000 }))).toMatchObject({ signal: 'sell', kind: 'trend_down' })
    })

    it('止损不等确认', () => {
      expect(evaluate(k(deathCrossCloses()), confirm2, holding({ price: 46000 }))).toMatchObject({ signal: 'sell', kind: 'stop_loss' })
    })

    it('cross 模式不受确认根数影响', () => {
      expect(evaluate(k(goldenCrossCloses()), { ...cross, confirmBars: 3 }, flat)).toMatchObject({ signal: 'buy', kind: 'golden_cross' })
    })

    it('往前数需要的 K 线不够时报错', () => {
      const p = { ...params, smaSlow: 98, smaFast: 20, confirmBars: 5 }
      expect(() => evaluate(k(goldenCrossCloses()), p, flat)).toThrow('需要至少 102 根')
    })
  })

  describe('cross 模式', () => {
    it('金叉且 RSI < 70 时买入；RSI 过高时观望', () => {
      const r = evaluate(k(goldenCrossCloses()), cross, flat)
      expect(r.indicators.prevSmaFast).toBeLessThanOrEqual(r.indicators.prevSmaSlow)
      expect(r).toMatchObject({ signal: 'buy', kind: 'golden_cross' })
      const hot = evaluate(k(hotGoldenCrossCloses()), cross, flat)
      expect(hot.indicators.rsi).toBeGreaterThanOrEqual(70)
      expect(hot.signal).toBe('hold')
    })

    it('没有交叉时不买，即使短期均线在上方', () => {
      const closes = [...steadyRiseCloses().slice(0, 90), ...Array.from({ length: 10 }, (_, i) => 48900 - i * 60)]
      expect(evaluate(k(closes), cross, flat).signal).toBe('hold')
    })

    it('持仓时死叉卖出；空仓时死叉观望', () => {
      expect(evaluate(k(deathCrossCloses()), cross, holding({ price: 49000 }))).toMatchObject({ signal: 'sell', kind: 'death_cross' })
      expect(evaluate(k(deathCrossCloses()), cross, flat).signal).toBe('hold')
    })

    it('止损后的买入锁定只对 trend 模式生效', () => {
      expect(evaluate(k(goldenCrossCloses()), cross, { ...flat, reentryLocked: true }).signal).toBe('buy')
    })

    it('横盘没有交叉时观望', () => {
      expect(evaluate(k(flatCloses()), cross, holding()).signal).toBe('hold')
    })
  })

  describe('止损', () => {
    it('现价跌破持仓均价 5% 时卖出，优先于其他信号', () => {
      // 52000 ≤ 55000 × 95% = 52250
      const r = evaluate(k(goldenCrossCloses()), params, holding({ price: 52000, entryPrice: 55000, peakPrice: 55000 }))
      expect(r).toMatchObject({ signal: 'sell', kind: 'stop_loss' })
      expect(evaluate(k(goldenCrossCloses()), params, holding({ price: 52300, entryPrice: 55000, peakPrice: 55000 })).signal).toBe('hold')
    })

    it('移动止损：现价比持仓以来最高价低 3% 时卖出', () => {
      const p = { ...params, trailingStopPct: 3 }
      // 54000 × 97% = 52380，高于止损线 50000 × 95% = 47500，所以移动止损先触发
      const r = evaluate(k(goldenCrossCloses()), p, holding({ price: 52300, entryPrice: 50000, peakPrice: 54000 }))
      expect(r).toMatchObject({ signal: 'sell', kind: 'trailing_stop' })
    })

    it('止损线取两条中较高的一条；都关闭时没有止损', () => {
      expect(stopLine({ stopLossPct: 5, trailingStopPct: 3 }, 50000, 54000)).toEqual({ price: 52380, kind: 'trailing_stop' })
      expect(stopLine({ stopLossPct: 5, trailingStopPct: 3 }, 50000, 50000)).toEqual({ price: 48500, kind: 'trailing_stop' })
      expect(stopLine({ stopLossPct: 5, trailingStopPct: 0 }, 50000, 54000)).toEqual({ price: 47500, kind: 'stop_loss' })
      expect(stopLine({ stopLossPct: 0, trailingStopPct: 0 }, 50000, 54000)).toBeNull()
    })
  })
})

describe('均线基线的固定参数', () => {
  const base = { ...BASELINE_PARAMS, stopLossPct: 5, trailingStopPct: 0 }
  const k = (closes: number[]) => makeKlines(closes, Date.UTC(2026, 9, 8))
  const flat = { hasPosition: false, price: 52000, entryPrice: null, peakPrice: null, reentryLocked: false }

  it('trend 模式、连续 2 根确认、不止盈', () => {
    expect(BASELINE_PARAMS).toMatchObject({ mode: 'trend', smaFast: 20, smaSlow: 50, rsiPeriod: 14, confirmBars: 2, rsiSellMin: 100 })
  })

  it('测试行情：只交叉了 1 根时不买，连续 2 根才买；连续 2 根在下方时卖', () => {
    expect(evaluate(k(goldenCrossCloses()), base, flat).signal).toBe('hold')
    expect(evaluate(k(uptrendCloses()), base, flat)).toMatchObject({ signal: 'buy', kind: 'trend_up' })
    expect(evaluate(k(downtrendCloses()), base, { ...flat, hasPosition: true, price: 48000, entryPrice: 48000, peakPrice: 48000 })).toMatchObject({ signal: 'sell', kind: 'trend_down' })
  })
})
