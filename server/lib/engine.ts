/**
 * 决策引擎：编排一轮决策。两种决策方式（面板里切换）：
 * - 规则模式：行情 → 规则信号 → 风控预检 → LLM 复核（仅买入）→ 风控 → 下单 → 记录
 * - LLM 决策模式：行情 → 止损检查 → 风控预检 → LLM 决定买入 / 卖出 / 观望和比例 → 风控 → 下单 → 记录。
 *   止损每轮都由程序检查；LLM 按面板设置的频率询问（每根 K 线一次，或每 N 分钟一次），其余轮次只检查止损
 *
 * 设计要点：
 * - 每轮一开始就插入一条“运行中”的决策记录，之后逐步补全；无论在哪一步停下（观望、否决、拦截、出错），
 *   这条记录都会被写完整。进程中途退出时，下次启动会把它标记为“中断”。
 * - 策略账本：程序只在面板设置的预算范围内交易，按实际成交（扣除手续费）更新账本，同时记下持仓成本和最高价用于止损；
 *   每轮核对账本不超过账户真实余额，超过说明有人手动动了账户或记账出错，立即暂停。
 * - 配置在每轮开始时取一次：面板里改了设置从下一轮起生效，不会让正在运行的一轮前后用两套参数。
 * - 运行锁：同一时间只允许一轮在跑。定时触发和“立即运行一次”撞车时，后来的直接返回 busy。
 *   不能只依赖 Nitro runTask 的同名去重——它在首次并发调用时有竞态。
 */
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type { RunResult } from '../../shared/types/api'
import type { Config } from './config'
import type { Ledger, Outcome, PauseState, Position, Store } from './db'
import type { Exchange, Kline, OrderResult, SymbolRules } from './exchange'
import type { DecideInput, Decider, Reviewer } from './llm'
import { log as defaultLog, redact, type Logger } from './logger'
import { dailyLossPct, evaluateRisk, precheck, type PrecheckInput } from './risk'
import { checkStop, closedKlines, evaluate, indicatorsOf, marketStats, stopLine, type Indicators } from './strategy'

/** 策略使用的 K 线根数 */
export const KLINE_LIMIT = 100
/** 发给 LLM 的 K 线根数 */
const LLM_KLINES = 24
/** 发给 LLM 的最近决策条数 */
const LLM_RECENT = 5
/** LLM 决策模式：发给 LLM 的它自己最近的决策条数、最近成交笔数 */
const LLM_DECIDE_RECENT = 10
const LLM_DECIDE_FILLS = 5

export type Trigger = 'schedule' | 'manual'

export interface EngineDeps {
  /** 取当前生效的配置（环境变量 + 面板设置），每轮开始时调用一次 */
  config: () => Config
  exchange: Exchange
  /** 规则模式的买入复核。没有配置 LLM 连接信息时为 null；配置了但面板里关闭时不会调用 */
  reviewer: Reviewer | null
  /** LLM 决策模式用。没有配置 LLM 连接信息时为 null */
  decider: Decider | null
  store: Store
  logger?: Logger
  now?: () => Date
  newId?: () => string
}

/** 一轮里行情、账本、持仓都查好之后，两种决策方式共用的上下文 */
interface RoundContext {
  config: Config
  id: string
  trigger: Trigger
  now: Date
  klines: Kline[]
  price: Decimal
  ledger: Ledger
  rules: SymbolRules
  /** 账户真实可用的币 */
  realBase: Decimal
  hasPosition: boolean
  position: Position | null
  dayStartEquity: Decimal
  equity: Decimal
}

/** LLM 决策模式的询问频率说明，提示词和面板共用 */
export function cadenceText(decision: Config['decision'], klineInterval: string): string {
  return decision.llmCadence === 'candle' ? `每根 ${klineInterval} K 线收盘后` : `每 ${decision.llmIntervalMinutes} 分钟`
}

const fmtUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** UTC 日期字符串 YYYY-MM-DD */
export const utcDate = (d: Date) => d.toISOString().slice(0, 10)

/** 下一个 UTC 0 点 */
export function nextUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
}

/** 账本资产总值（USDT 计） */
export const equityOf = (ledger: Ledger, price: Decimal) => ledger.usdt.plus(ledger.base.mul(price))

const sumCommission = (order: OrderResult, asset: string) =>
  order.commissions.filter(c => c.asset === asset).reduce((s, c) => s.plus(c.amount), new Decimal(0))

/** 持币市值达到交易所最小下单额才算持仓；卖出后剩下的、卖不掉的零头不算 */
export const isPosition = (base: Decimal, price: Decimal, rules: SymbolRules) =>
  base.mul(price).gte(Decimal.max(rules.minNotional, '0.00000001'))

/**
 * 成交后更新持仓成本：买入累加花掉的 USDT（含以 USDT 支付的手续费；以币支付的手续费已体现在持币变少上），
 * 卖出按卖掉的比例减少成本；卖完（只剩零头）就清空。
 */
export function updatePosition(
  pos: Position | null,
  side: 'buy' | 'sell',
  order: OrderResult,
  rules: SymbolRules,
  before: Ledger,
  after: Ledger,
  price: Decimal
): Position | null {
  if (!isPosition(after.base, price, rules)) return null
  if (side === 'buy') {
    const spent = order.quoteQty.plus(sumCommission(order, rules.quoteAsset))
    const fillPrice = order.quoteQty.div(order.executedQty)
    return pos ? { cost: pos.cost.plus(spent), peak: Decimal.max(pos.peak, fillPrice) } : { cost: spent, peak: fillPrice }
  }
  if (!pos || before.base.lte(0)) return pos
  return { cost: pos.cost.mul(after.base).div(before.base), peak: pos.peak }
}

/**
 * 暂停时这笔单还下不下：当日亏损熔断只拦买入——卖出（含止损）是降低风险的操作，熔断期间也要能执行，
 * 否则熔断反而会让止损失效；手动暂停（用户叫停）和对账暂停（账本可能不准）什么单都不下。
 */
export const pauseBlocks = (pause: PauseState, signal: 'buy' | 'sell' | 'hold') =>
  pause.paused && !(pause.source === 'daily_loss' && signal === 'sell')

/** 成交后更新账本：买入扣 USDT、加币（扣掉以币支付的手续费）；卖出反之。 */
export function applyFill(ledger: Ledger, side: 'buy' | 'sell', order: OrderResult, rules: SymbolRules): Ledger {
  const feeBase = sumCommission(order, rules.baseAsset)
  const feeQuote = sumCommission(order, rules.quoteAsset)
  if (side === 'buy') {
    return {
      usdt: ledger.usdt.minus(order.quoteQty).minus(feeQuote),
      base: ledger.base.plus(order.executedQty).minus(feeBase)
    }
  }
  return {
    usdt: ledger.usdt.plus(order.quoteQty).minus(feeQuote),
    base: ledger.base.minus(order.executedQty).minus(feeBase)
  }
}

export class Engine {
  private current: Promise<RunResult> | null = null
  private readonly log: Logger
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.logger ?? defaultLog
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  get isRunning(): boolean {
    return this.current !== null
  }

  /** 执行一轮。已有一轮在运行时直接返回 busy。 */
  async runOnce(trigger: Trigger): Promise<RunResult> {
    if (this.current) {
      this.log.warn(`已有一轮在运行，跳过本次触发（${trigger === 'manual' ? '手动' : '定时'}）`)
      return { status: 'busy' }
    }
    // 赋值发生在任何 await 之前，所以不会有两个调用同时通过上面的检查
    this.current = this.round(trigger)
    try {
      return await this.current
    } finally {
      this.current = null
    }
  }

  /** 等待当前这一轮跑完（进程退出前调用）。 */
  async waitIdle(): Promise<void> {
    await this.current?.catch(() => undefined)
  }

  pause(reason = '手动暂停'): PauseState {
    const state: PauseState = { paused: true, reason, source: 'manual', until: null, since: this.now().toISOString() }
    this.deps.store.setPause(state)
    this.log.info(`自动交易已暂停：${reason}`)
    return state
  }

  resume(): PauseState {
    const state: PauseState = { paused: false, reason: null, source: null, until: null, since: null }
    this.deps.store.setPause(state)
    this.log.info('自动交易已恢复')
    return state
  }

  private async round(trigger: Trigger): Promise<RunResult> {
    const { exchange, store } = this.deps
    const config = this.deps.config()
    const now = this.now()
    const id = this.newId()
    store.insertDecision({ id, createdAt: now.toISOString(), trigger, symbol: config.symbol, mode: config.decision.mode, outcome: 'running' })
    this.log.info(`开始第 ${id} 轮决策（${trigger === 'manual' ? '手动' : '定时'}）`)

    let price: Decimal | null = null
    let ledger: Ledger | null = null
    let outcome: Outcome
    try {
      this.autoResume(now)

      const rules = await exchange.getSymbolRules(config.symbol)
      if (rules.quoteAsset !== 'USDT') throw new Error(`只支持以 USDT 计价的交易对，${config.symbol} 的计价资产是 ${rules.quoteAsset}`)
      // 多取一根，去掉还没收盘的那根后仍有 KLINE_LIMIT 根
      const rawKlines = await exchange.getKlines(config.symbol, config.strategy.klineInterval, KLINE_LIMIT + 1)
      const klines = closedKlines(rawKlines, now.getTime()).slice(-KLINE_LIMIT)
      price = await exchange.getPrice(config.symbol)
      const balances = await exchange.getBalances()
      store.updateDecision(id, { price: price.toFixed() })

      // 首次运行：初始化策略账本，并记下初始价格用于计算“一直持有”基准
      if (!store.getInitial()) {
        store.transaction(() => {
          store.setInitial({ budget: config.budgetUsdt.toFixed(), price: price!.toFixed(), at: now.toISOString() })
          store.setLedger({ usdt: config.budgetUsdt, base: new Decimal(0) })
        })
        this.log.info(`策略账本初始化：${config.budgetUsdt.toFixed()} USDT，初始价格 ${price.toFixed()}`)
      }
      ledger = store.getLedger()!

      // 核对账本不超过账户真实余额
      const realQuote = balances[rules.quoteAsset]?.free ?? new Decimal(0)
      const realBase = balances[rules.baseAsset]?.free ?? new Decimal(0)
      if (ledger.usdt.gt(realQuote) || ledger.base.gt(realBase)) {
        const msg = `账本超过账户真实可用余额（账本 ${ledger.usdt.toFixed()} ${rules.quoteAsset} / ${ledger.base.toFixed()} ${rules.baseAsset}，`
          + `账户 ${realQuote.toFixed()} ${rules.quoteAsset} / ${realBase.toFixed()} ${rules.baseAsset}），已自动暂停，请检查账户`
        store.setPause({ paused: true, reason: msg, source: 'reconcile', until: null, since: now.toISOString() })
        throw new Error(msg)
      }

      // UTC 每天第一轮记下当天起始资产，作为亏损熔断的基准
      const equity = equityOf(ledger, price)
      let dayStart = store.getDayStart()
      if (!dayStart || dayStart.date !== utcDate(now)) {
        dayStart = { date: utcDate(now), equity: equity.toFixed() }
        store.setDayStart(dayStart)
      }
      const dayStartEquity = new Decimal(dayStart.equity)
      this.checkDailyLoss(config, dayStartEquity, equity, now)

      // 持仓成本与最高价（止损用）
      const hasPosition = isPosition(ledger.base, price, rules)
      let position = hasPosition ? store.getPosition() : null
      if (hasPosition && !position) {
        // 没有成本记录的持仓（例如旧版本留下的），按当前价补记
        position = { cost: ledger.base.mul(price), peak: price }
        this.log.warn(`持仓没有成本记录，按当前价 ${price.toFixed()} 补记`)
      }
      if (position && price.gt(position.peak)) position = { ...position, peak: price }
      store.setPosition(position)

      const ctx: RoundContext = { config, id, trigger, now, klines, price, ledger, rules, realBase, hasPosition, position, dayStartEquity, equity }
      outcome = config.decision.mode === 'llm' ? await this.llmRound(ctx) : await this.rulesRound(ctx)
      ledger = store.getLedger()!
    } catch (e) {
      outcome = 'error'
      const message = redact((e as Error).message)
      const prev = store.getDecision(id)?.error
      store.updateDecision(id, { error: prev ? `${prev}；${message}` : message })
      this.log.error(`第 ${id} 轮出错：${message}`)
    }

    store.updateDecision(id, { outcome })
    if (price && ledger) this.snapshot(id, now, price, ledger)
    this.log.info(`第 ${id} 轮结束：${outcome}`)
    return { status: 'done', decisionId: id, outcome }
  }

  /** 规则模式：均线 + RSI 给出信号，买入可选 LLM 复核。 */
  private async rulesRound(ctx: RoundContext): Promise<Outcome> {
    const { store } = this.deps
    const { config, id, now, klines, price, hasPosition, position } = ctx
    let outcome: Outcome

    const lock = store.getReentryLock()
    const strategy = evaluate(klines, config.strategy, {
      hasPosition,
      price: price.toNumber(),
      entryPrice: position ? position.cost.div(ctx.ledger.base).toNumber() : null,
      peakPrice: position ? position.peak.toNumber() : null,
      reentryLocked: lock !== null
    })
    // 短期均线回到长期均线下方，说明止损 / 止盈时的那段行情已经结束，解除买入锁定
    if (lock && strategy.indicators.smaFast <= strategy.indicators.smaSlow) {
      store.setReentryLock(null)
      this.log.info('短期均线已回到长期均线下方，解除卖出后的买入锁定')
    }
    // 决策间隔通常比 K 线周期短（默认 15 分钟 vs 1 小时），同一根 K 线会被看到好几轮。
    // 同一根 K 线上的同一个信号只处理一次，否则会反复调用 LLM、反复下单。
    const candle = klines.at(-1)!.openTime
    const handled = store.getHandledSignal()
    if (strategy.signal !== 'hold' && handled?.candle === candle && handled.signal === strategy.signal) {
      strategy.note = `这根 K 线上的${strategy.signal === 'buy' ? '买入' : '卖出'}信号已在之前的轮次处理过，不重复执行。${strategy.note}`
      strategy.signal = 'hold'
    }
    store.updateDecision(id, {
      indicators: { ...strategy.indicators },
      signal: strategy.signal,
      signalNote: strategy.note
    })

    if (pauseBlocks(store.getPause(), strategy.signal)) {
      outcome = 'paused'
    } else if (strategy.signal === 'hold') {
      outcome = 'hold'
    } else {
      const side = strategy.signal
      const riskInput = this.riskInput(ctx, side)
      // 先做不需要金额的风控检查，注定下不了单时不调用 LLM
      const pre = precheck(riskInput)
      if (pre) {
        store.updateDecision(id, { riskPassed: false, riskRule: pre.rule ?? null, riskReason: pre.reason })
        outcome = 'risk_block'
      } else {
        outcome = await this.reviewAndTrade(config, id, side, strategy.reason, strategy.indicators, klines, riskInput)
        // 止损 / 止盈卖出后锁定买入：trend 模式下均线多半还在上方，不锁的话下一根 K 线就会买回去
        if (outcome === 'filled' && (strategy.kind === 'stop_loss' || strategy.kind === 'trailing_stop' || strategy.kind === 'take_profit')) {
          store.setReentryLock({ since: now.toISOString(), reason: strategy.note })
        }
      }
      // 走完了风控 / 复核 / 下单（不论结果），记下这根 K 线的信号已处理；出错时不记，下一轮可以重试
      if (outcome !== 'paused') store.setHandledSignal({ candle, signal: side })
    }
    return outcome
  }

  /**
   * LLM 决策模式：止损由程序每轮检查；其余由 LLM 决定买入 / 卖出 / 观望和比例，再经过风控。
   * 同一个询问时段（一根 K 线或 N 分钟）只问一次，手动运行不受限制。LLM 没给出合法结果时这个时段不算问过，下一轮重试。
   */
  private async llmRound(ctx: RoundContext): Promise<Outcome> {
    const { store } = this.deps
    const { config, id, now, klines, price, ledger, rules, hasPosition, position } = ctx
    if (!klines.length) throw new Error('没有取到已收盘的 K 线')
    const pause = store.getPause()
    const entryPrice = position ? position.cost.div(ledger.base) : null

    const stop = checkStop(config.strategy, {
      hasPosition,
      price: price.toNumber(),
      entryPrice: entryPrice?.toNumber() ?? null,
      peakPrice: position?.peak.toNumber() ?? null
    })
    if (stop) {
      store.updateDecision(id, { signal: 'sell', signalNote: stop.note })
      if (pauseBlocks(pause, 'sell')) return 'paused'
      const riskInput = this.riskInput(ctx, 'sell')
      const pre = precheck(riskInput)
      if (pre) {
        store.updateDecision(id, { riskPassed: false, riskRule: pre.rule ?? null, riskReason: pre.reason })
        return 'risk_block'
      }
      return this.trade(config, id, 'sell', 100, riskInput)
    }

    // 手动暂停和对账暂停时什么单都不下，也就不用问 LLM
    if (pauseBlocks(pause, 'sell')) {
      store.updateDecision(id, { signalNote: '暂停中，本轮不询问 LLM' })
      return 'paused'
    }
    const decider = this.deps.decider
    if (!decider) throw new Error('LLM 决策模式需要在 .env 里配置 LLM 连接信息（LLM_BASE_URL、LLM_API_KEY、LLM_MODEL），配置后重启')

    const slot = this.llmSlot(config, klines, now)
    if (ctx.trigger === 'schedule' && store.getLlmSlot() === slot.key) {
      store.updateDecision(id, { signal: 'hold', signalNote: `${slot.label}已经问过 LLM，下次在 ${fmtUtc(slot.next)} 之后；这期间只检查止损` })
      return 'hold'
    }

    // 先看买、卖还能不能做：都不能就不浪费一次 LLM 调用，也不算问过，限制解除后下一轮就会问
    const buyBlocked = pauseBlocks(pause, 'buy') ? pause.reason ?? '暂停中' : precheck(this.riskInput(ctx, 'buy'))?.reason ?? null
    const sellBlocked = hasPosition ? precheck(this.riskInput(ctx, 'sell'))?.reason ?? null : '空仓，没有可卖的币'
    if (buyBlocked && sellBlocked) {
      store.updateDecision(id, { signal: 'hold', signalNote: `现在不能买入（${buyBlocked}），也没有可卖的持仓，本轮不询问 LLM` })
      return pauseBlocks(pause, 'buy') ? 'paused' : 'hold'
    }

    const positionValue = ledger.base.mul(price)
    const stopNow = position ? stopLine(config.strategy, entryPrice!.toNumber(), position.peak.toNumber()) : null
    const input: DecideInput = {
      symbol: config.symbol,
      baseAsset: rules.baseAsset,
      klineInterval: config.strategy.klineInterval,
      cadence: cadenceText(config.decision, config.strategy.klineInterval),
      now: now.toISOString(),
      price: price.toFixed(),
      klines: klines.slice(-config.decision.llmKlines),
      indicators: indicatorsOf(klines.map(k => Number(k.close)), config.strategy),
      periods: config.strategy,
      stats: marketStats(klines),
      ledger: { usdt: ledger.usdt.toFixed(), base: ledger.base.toFixed(), positionValue: positionValue.toFixed(2), equity: ctx.equity.toFixed(2) },
      position: position && entryPrice
        ? {
            entryPrice: entryPrice.toSignificantDigits(10).toFixed(),
            pnlPct: price.minus(entryPrice).div(entryPrice).mul(100).toFixed(2),
            peakPrice: position.peak.toFixed(),
            stopPrice: stopNow ? new Decimal(stopNow.price).toSignificantDigits(10).toFixed() : null
          }
        : null,
      stopRules: { stopLossPct: config.strategy.stopLossPct, trailingStopPct: config.strategy.trailingStopPct },
      limits: { maxOrderUsdt: config.risk.maxOrderUsdt.toFixed(), minOrderUsdt: rules.minNotional.toFixed(), maxPositionPct: config.risk.maxPositionPct },
      blocked: { buy: buyBlocked, sell: sellBlocked },
      // 按时间先后排列，读起来更顺
      recentDecisions: store.recentLlmDecisions(LLM_DECIDE_RECENT).reverse().map(d => ({
        time: d.createdAt,
        price: d.price,
        action: d.llmDecision!,
        sizePct: d.llmSizePct,
        outcome: d.outcome,
        reason: d.llmReason
      })),
      recentFills: store.recentFills(LLM_DECIDE_FILLS).reverse().map(d => ({
        time: d.createdAt,
        side: d.orderSide === 'BUY' ? 'buy' : 'sell',
        price: d.price,
        qty: d.filledQty,
        quote: d.filledQuote
      }))
    }
    const result = await decider.decide(input)
    store.updateDecision(id, {
      signal: result.action,
      signalNote: result.valid ? null : 'LLM 没有给出合法结果，程序代为观望，下一轮重试',
      llmDecision: result.action,
      llmSizePct: result.sizePct,
      llmConfidence: result.confidence,
      llmReason: result.reason,
      llmRaw: result.raw,
      llmCalls: result.calls.map(c => ({ ...c, error: c.error ? redact(c.error) : null })),
      llmPrompt: result.prompt,
      error: result.error ? redact(result.error) : null
    })
    if (result.valid) store.setLlmSlot(slot.key)
    if (result.action === 'hold') return 'hold'
    return this.trade(config, id, result.action, result.sizePct, this.riskInput(ctx, result.action))
  }

  /** 当前所在的询问时段：每根 K 线一个，或按整点对齐的每 N 分钟一个。key 带上周期，改了设置就是新的时段 */
  private llmSlot(config: Config, klines: Kline[], now: Date): { key: string, label: string, next: Date } {
    const d = config.decision
    if (d.llmCadence === 'candle') {
      const last = klines.at(-1)!
      const duration = last.closeTime + 1 - last.openTime
      return { key: `candle:${config.strategy.klineInterval}:${last.openTime}`, label: '这根 K 线收盘后', next: new Date(last.closeTime + 1 + duration) }
    }
    const ms = d.llmIntervalMinutes * 60_000
    const n = Math.floor(now.getTime() / ms)
    return { key: `every:${d.llmIntervalMinutes}:${n}`, label: `这个时段（每 ${d.llmIntervalMinutes} 分钟一次）`, next: new Date((n + 1) * ms) }
  }

  private riskInput(ctx: RoundContext, side: 'buy' | 'sell'): PrecheckInput {
    const { store } = this.deps
    const { config, now, ledger } = ctx
    return {
      side,
      price: ctx.price,
      ledger,
      sellableBase: Decimal.min(ledger.base, ctx.realBase),
      rules: ctx.rules,
      limits: config.risk,
      tradesToday: store.countFilledSince(`${utcDate(now)}T00:00:00.000Z`),
      lastTradeAt: store.lastFilledAt(),
      now,
      dayStartEquity: ctx.dayStartEquity,
      equity: ctx.equity
    }
  }

  /** 买入先经 LLM 复核；然后风控算出最终金额 / 数量并下单。 */
  private async reviewAndTrade(
    config: Config,
    id: string,
    side: 'buy' | 'sell',
    signalNote: string,
    indicators: Indicators,
    klines: Kline[],
    riskInput: PrecheckInput
  ): Promise<Outcome> {
    const { store } = this.deps
    const { ledger, rules, price, now } = riskInput
    let sizePct = 100

    // LLM 只复核买入。卖出（含止损）是降低风险的操作，直接全部卖出
    if (side === 'buy' && config.llm.enabled && this.deps.reviewer) {
      const review = await this.deps.reviewer.review({
        symbol: config.symbol,
        signalNote,
        now: now.toISOString(),
        price: price.toFixed(),
        klineInterval: config.strategy.klineInterval,
        klines: klines.slice(-LLM_KLINES),
        indicators,
        periods: config.strategy,
        stats: marketStats(klines),
        ledger: { usdt: ledger.usdt.toFixed(), base: ledger.base.toFixed(), baseAsset: rules.baseAsset },
        stopRules: config.strategy,
        limits: { maxOrderUsdt: config.risk.maxOrderUsdt.toFixed(), minOrderUsdt: rules.minNotional.toFixed(), maxPositionPct: config.risk.maxPositionPct },
        // 按时间先后排列，读起来更顺
        recentDecisions: store.recentDecisions(LLM_RECENT).reverse().map(d => ({
          time: d.createdAt,
          price: d.price,
          signal: d.signal ?? '-',
          llmDecision: d.llmDecision,
          outcome: d.outcome,
          reason: d.llmReason
        }))
      })
      store.updateDecision(id, {
        llmDecision: review.decision,
        llmSizePct: review.sizePct,
        llmConfidence: review.confidence,
        llmReason: review.reason,
        llmRaw: review.raw,
        // 错误信息里可能带着服务端回显的内容，和 error 字段一样先打码再入库
        llmCalls: review.calls.map(c => ({ ...c, error: c.error ? redact(c.error) : null })),
        llmPrompt: review.prompt,
        error: review.error ? redact(review.error) : null
      })
      if (review.decision === 'reject') return 'llm_reject'
      sizePct = review.sizePct
    }
    return this.trade(config, id, side, sizePct, riskInput)
  }

  /** 风控算出最终金额 / 数量，通过就下单。 */
  private async trade(config: Config, id: string, side: 'buy' | 'sell', sizePct: number, riskInput: PrecheckInput): Promise<Outcome> {
    const { store } = this.deps
    const { ledger, rules, price } = riskInput
    const risk = evaluateRisk({ ...riskInput, sizePct })
    store.updateDecision(id, {
      riskPassed: risk.passed,
      riskRule: risk.rule ?? null,
      riskReason: risk.reason,
      orderSide: risk.passed ? (side === 'buy' ? 'BUY' : 'SELL') : null,
      orderQuoteAmount: risk.quoteAmount?.toFixed() ?? null,
      orderQty: risk.quantity?.toFixed() ?? null
    })
    if (!risk.passed) return 'risk_block'
    // LLM 复核期间（最长几分钟）用户可能点了暂停，下单前再确认一次
    if (pauseBlocks(store.getPause(), side)) return 'paused'
    return this.placeOrder(config, id, side, risk.quoteAmount, risk.quantity, rules, ledger, price)
  }

  private async placeOrder(
    config: Config,
    id: string,
    side: 'buy' | 'sell',
    quoteAmount: Decimal | undefined,
    quantity: Decimal | undefined,
    rules: SymbolRules,
    ledger: Ledger,
    price: Decimal
  ): Promise<Outcome> {
    const { exchange, store } = this.deps
    // 决策 ID 作为 newClientOrderId，重试时交易所能识别出是同一笔
    const order = side === 'buy'
      ? await exchange.marketBuy(config.symbol, quoteAmount!, id)
      : await exchange.marketSell(config.symbol, quantity!, id)
    const filled = order.executedQty.gt(0)
    const newLedger = applyFill(ledger, side, order, rules)
    const newPosition = filled ? updatePosition(store.getPosition(), side, order, rules, ledger, newLedger, price) : null
    store.transaction(() => {
      if (filled) {
        store.setLedger(newLedger)
        store.setPosition(newPosition)
      }
      store.updateDecision(id, {
        orderId: order.orderId,
        orderStatus: order.status,
        filledQty: order.executedQty.toFixed(),
        filledQuote: order.quoteQty.toFixed(),
        commission: order.commissions.map(c => `${c.amount.toFixed()} ${c.asset}`).join(', ') || null
      })
    })
    this.log.info(`下单完成：${side === 'buy' ? '买入' : '卖出'} ${order.executedQty.toFixed()} ${rules.baseAsset}，金额 ${order.quoteQty.toFixed()} USDT，状态 ${order.status}`)
    return filled ? 'filled' : 'unfilled'
  }

  /** 熔断到期（到了下一个 UTC 日）自动恢复 */
  private autoResume(now: Date): void {
    const pause = this.deps.store.getPause()
    if (pause.paused && pause.source === 'daily_loss' && pause.until && new Date(pause.until) <= now) {
      this.resume()
      this.log.info('亏损熔断已到期，自动恢复')
    }
  }

  private checkDailyLoss(config: Config, dayStartEquity: Decimal, equity: Decimal, now: Date): void {
    const { store } = this.deps
    const loss = dailyLossPct(dayStartEquity, equity)
    if (loss.lt(config.risk.dailyLossLimitPct) || store.getPause().paused) return
    const until = nextUtcMidnight(now)
    const reason = `当日亏损熔断：今日已亏损 ${loss.toFixed(2)}%（上限 ${config.risk.dailyLossLimitPct}%），暂停到 ${until.toISOString()}`
    store.setPause({ paused: true, reason, source: 'daily_loss', until: until.toISOString(), since: now.toISOString() })
    this.log.warn(reason)
  }

  private snapshot(id: string, now: Date, price: Decimal, ledger: Ledger): void {
    const initial = this.deps.store.getInitial()
    if (!initial) return
    // 基准：启动时用全部预算买入并一直持有，现在值多少
    const benchmark = new Decimal(initial.budget).mul(price).div(initial.price)
    this.deps.store.insertSnapshot({
      createdAt: now.toISOString(),
      decisionId: id,
      price: price.toFixed(),
      usdt: ledger.usdt.toFixed(),
      base: ledger.base.toFixed(),
      total: equityOf(ledger, price).toFixed(),
      benchmark: benchmark.toFixed()
    })
  }
}
