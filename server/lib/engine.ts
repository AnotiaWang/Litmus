/**
 * 决策引擎：编排一轮（tick）。
 *
 * 每轮先取一次行情（交易对规则、K 线、现价），记一条行情快照；然后所有参赛模型拿着这同一份行情并行决策，
 * 各自在自己的账本里模拟成交，最后每个模型记一条资产快照。
 * - LLM 模型：止损检查 → 风控预检 → 问 LLM（每根 K 线收盘后一次）→ 风控 → 模拟成交
 * - 均线基线：均线 + RSI 规则信号（含止损）→ 风控 → 模拟成交，不调用 LLM
 *
 * 设计要点：
 * - 所有模型按快照价格成交，LLM 回得快慢不影响成交价，模型之间唯一的差别就是决策本身。
 * - 决策记录只在问过 LLM、触发止损、规则给出买卖信号或出错时写；其余轮次（止损检查、暂停中）只记资产快照。
 * - 一个模型出错不影响其他模型；行情取不到时整轮跳过，记下原因。
 * - 赛季配置在赛季内不变；模型中途加入时，从加入后的第一轮开始按初始资金建账本。
 * - 运行锁：同一时间只允许一轮在跑。定时触发和“立即运行一次”撞车时，后来的直接返回 busy。
 *   不能只依赖 Nitro runTask 的同名去重——它在首次并发调用时有竞态。
 */
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type { SeasonConfig } from '../../shared/settings'
import type { Outcome, RunResult } from '../../shared/types/api'
import type { AgentRow, Circuit, Decision, DecisionSummary, EntryState, PauseState, SeasonRow, Store } from './db'
import { applyFill, equityOf, isPosition, paperFill, updatePosition, type Ledger, type Position } from './ledger'
import { summarizeCalls, type Decider, type DecideInput } from './llm'
import { log as defaultLog, redact, type Logger } from './logger'
import type { Kline, Market, SymbolRules } from './market'
import { dailyLossPct, evaluateRisk, maxOrderUsdt, precheck, type PrecheckInput } from './risk'
import { BASELINE_PARAMS, checkStop, closedKlines, evaluate, indicatorsOf, marketStats, stopLine } from './strategy'

/** 每轮取的已收盘 K 线根数（均线基线需要 SMA50 + 确认根数，LLM 最多发 100 根） */
export const KLINE_LIMIT = 100
/** 发给 LLM 的它自己最近的决策条数、最近成交笔数 */
const LLM_RECENT_DECISIONS = 10
const LLM_RECENT_FILLS = 5

export type Trigger = 'schedule' | 'manual'

export interface EngineDeps {
  store: Store
  market: Market
  /** 取某个 LLM 模型的客户端（运行时按 Provider 和模型配置缓存） */
  deciderFor: (agent: AgentRow) => Decider
  logger?: Logger
  now?: () => Date
  newId?: () => string
}

/** 一轮里所有模型共用的行情快照 */
interface TickContext {
  season: SeasonRow
  config: SeasonConfig
  tickId: number
  trigger: Trigger
  now: Date
  klines: Kline[]
  price: Decimal
  rules: SymbolRules
  pause: PauseState
}

/** 一个模型在这一轮里的上下文。ledger / position 在成交后更新，轮末和决策记录一起写入数据库 */
interface AgentContext extends TickContext {
  agent: AgentRow
  state: EntryState
  ledger: Ledger
  position: Position | null
  hasPosition: boolean
  dayStartEquity: Decimal
  equity: Decimal
  circuit: Circuit | null
  /** 这一轮的决策记录草稿 */
  decision: Decision
  /** 是否写入决策记录 */
  record: boolean
  filled: boolean
}

/** LLM 的询问频率说明，提示词和面板共用 */
export const cadenceText = (klineInterval: string) => `每根 ${klineInterval} K 线收盘后`

const fmtUtc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** UTC 日期字符串 YYYY-MM-DD */
export const utcDate = (d: Date) => d.toISOString().slice(0, 10)

/** 下一个 UTC 0 点 */
export function nextUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
}

/**
 * 组装发给 LLM 的输入：行情、账本、持仓、限额和它自己最近的决策 / 成交（数据库里按时间倒序，这里改成正序，读起来更顺）。
 * 引擎和管理页面的“测试模型”共用。
 */
export function buildDecideInput(p: {
  config: SeasonConfig
  rules: SymbolRules
  klines: Kline[]
  price: Decimal
  now: Date
  ledger: Ledger
  equity: Decimal
  position: Position | null
  blocked: DecideInput['blocked']
  recentDecisions: DecisionSummary[]
  recentFills: DecisionSummary[]
}): DecideInput {
  const { config, ledger, price, position } = p
  const entryPrice = position ? position.cost.div(ledger.base) : null
  const stopNow = position ? stopLine(config.risk, entryPrice!.toNumber(), position.peak.toNumber()) : null
  return {
    symbol: config.symbol,
    baseAsset: p.rules.baseAsset,
    klineInterval: config.klineInterval,
    cadence: cadenceText(config.klineInterval),
    now: p.now.toISOString(),
    price: price.toFixed(),
    klines: p.klines.slice(-config.llmKlines),
    indicators: indicatorsOf(p.klines.map(k => Number(k.close)), BASELINE_PARAMS),
    periods: BASELINE_PARAMS,
    stats: marketStats(p.klines),
    ledger: { usdt: ledger.usdt.toFixed(), base: ledger.base.toFixed(), positionValue: ledger.base.mul(price).toFixed(2), equity: p.equity.toFixed(2) },
    position: position && entryPrice
      ? {
          entryPrice: entryPrice.toSignificantDigits(10).toFixed(),
          pnlPct: price.minus(entryPrice).div(entryPrice).mul(100).toFixed(2),
          peakPrice: position.peak.toFixed(),
          stopPrice: stopNow ? new Decimal(stopNow.price).toSignificantDigits(10).toFixed() : null
        }
      : null,
    stopRules: { stopLossPct: config.risk.stopLossPct, trailingStopPct: config.risk.trailingStopPct },
    limits: {
      maxOrderUsdt: maxOrderUsdt({ ledger, price, limits: config.risk }).toFixed(2),
      maxOrderPct: config.risk.maxOrderPct,
      minOrderUsdt: p.rules.minNotional.toFixed(),
      maxPositionPct: config.risk.maxPositionPct
    },
    blocked: p.blocked,
    recentDecisions: [...p.recentDecisions].reverse().map(r => ({
      time: r.createdAt,
      price: r.price,
      action: r.llmDecision!,
      sizePct: r.llmSizePct,
      outcome: r.outcome,
      reason: r.llmReason
    })),
    recentFills: [...p.recentFills].reverse().map(r => ({
      time: r.createdAt,
      side: r.orderSide === 'buy' ? 'buy' : 'sell',
      price: r.price,
      qty: r.filledQty,
      quote: r.filledQuote
    }))
  }
}

/** 止损参数：均线基线的固定参数 + 赛季的止损设置 */
export const baselineParams = (config: SeasonConfig) => ({ ...BASELINE_PARAMS, stopLossPct: config.risk.stopLossPct, trailingStopPct: config.risk.trailingStopPct })

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
    this.current = this.tick(trigger)
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

  pause(): PauseState {
    const state: PauseState = { paused: true, since: this.now().toISOString() }
    this.deps.store.setPause(state)
    this.log.info('已暂停：所有模型不再询问 LLM、不交易，资产照常记录')
    return state
  }

  resume(): PauseState {
    const state: PauseState = { paused: false, since: null }
    this.deps.store.setPause(state)
    this.log.info('已恢复运行')
    return state
  }

  private async tick(trigger: Trigger): Promise<RunResult> {
    const { store, market } = this.deps
    const season = store.currentSeason()
    if (!season) return { status: 'done', tickId: null, error: '没有进行中的赛季', outcomes: [] }
    const config = season.config
    const now = this.now()

    let rules: SymbolRules
    let klines: Kline[]
    let price: Decimal
    try {
      rules = await market.getSymbolRules(config.symbol)
      if (rules.quoteAsset !== 'USDT') throw new Error(`只支持以 USDT 计价的交易对，${config.symbol} 的计价资产是 ${rules.quoteAsset}`)
      // 多取一根，去掉还没收盘的那根后仍有 KLINE_LIMIT 根
      const raw = await market.getKlines(config.symbol, config.klineInterval, KLINE_LIMIT + 1)
      klines = closedKlines(raw, now.getTime()).slice(-KLINE_LIMIT)
      if (!klines.length) throw new Error('没有取到已收盘的 K 线')
      price = await market.getPrice(config.symbol)
    } catch (e) {
      const error = `取行情失败，本轮跳过：${redact((e as Error).message)}`
      const tickId = store.insertTick({ seasonId: season.id, at: now.toISOString(), trigger, price: null, error })
      this.log.error(error)
      return { status: 'done', tickId, error, outcomes: [] }
    }

    const tickId = store.insertTick({ seasonId: season.id, at: now.toISOString(), trigger, price: price.toFixed(), error: null })
    const ctx: TickContext = { season, config, tickId, trigger, now, klines, price, rules, pause: store.getPause() }
    const agents = new Map(store.listAgents().map(a => [a.id, a]))
    const playing = store.listEntries(season.id)
      .filter(e => !e.leftAt)
      .map(e => agents.get(e.agentId))
      .filter((a): a is AgentRow => a?.status === 'active')
    this.log.info(`第 ${tickId} 轮开始（${trigger === 'manual' ? '手动' : '定时'}）：${config.symbol} ${price.toFixed()}，${playing.length} 个模型`)
    const outcomes = await Promise.all(playing.map(agent => this.agentRound(ctx, agent)))
    this.log.info(`第 ${tickId} 轮结束：${outcomes.map(o => `${agents.get(o.agentId)!.name} ${o.outcome}`).join('，') || '没有参赛模型'}`)
    return { status: 'done', tickId, error: null, outcomes }
  }

  /** 一个模型的一轮：准备账本 → 决策 → 把账本、决策记录和资产快照一起写入。出错只影响这个模型。 */
  private async agentRound(tick: TickContext, agent: AgentRow): Promise<{ agentId: number, outcome: Outcome, decisionId: string | null }> {
    const { store } = this.deps
    const { season, config, now, price, rules } = tick
    const state = store.entry(season.id, agent.id)

    // 第一次参与运行：按初始资金建账本，记下起点价格（“一直持有”的基准）
    if (!state.getInitial()) {
      store.transaction(() => {
        state.setInitial({ capital: config.initialCapital, price: price.toFixed(), at: now.toISOString() })
        state.setLedger({ usdt: new Decimal(config.initialCapital), base: new Decimal(0) })
      })
    }
    const ledger = state.getLedger()!
    const equity = equityOf(ledger, price)

    // UTC 每天第一轮记下当天起始资产，作为亏损熔断的基准
    let dayStart = state.getDayStart()
    if (!dayStart || dayStart.date !== utcDate(now)) {
      dayStart = { date: utcDate(now), equity: equity.toFixed() }
      state.setDayStart(dayStart)
    }
    const dayStartEquity = new Decimal(dayStart.equity)
    const circuit = this.updateCircuit(state, config, dayStartEquity, equity, now, agent)

    // 持仓成本与最高价（止损用）
    const hasPosition = isPosition(ledger.base, price, rules)
    let position = hasPosition ? state.getPosition() : null
    if (hasPosition && !position) {
      // 理论上不会出现：有币但没有成本记录，按当前价补记
      position = { cost: ledger.base.mul(price), peak: price }
      this.log.warn(`${agent.name}：持仓没有成本记录，按当前价 ${price.toFixed()} 补记`)
    }
    if (position && price.gt(position.peak)) position = { ...position, peak: price }

    const ctx: AgentContext = {
      ...tick,
      agent,
      state,
      ledger,
      position,
      hasPosition,
      dayStartEquity,
      equity,
      circuit,
      decision: this.newDecision(tick, agent),
      record: false,
      filled: false
    }
    let outcome: Outcome
    try {
      outcome = agent.kind === 'llm' ? await this.llmRound(ctx) : this.baselineRound(ctx)
    } catch (e) {
      outcome = 'error'
      ctx.record = true
      const message = redact((e as Error).message)
      ctx.decision.error = ctx.decision.error ? `${ctx.decision.error}；${message}` : message
      this.log.error(`${agent.name}：第 ${tick.tickId} 轮出错：${message}`)
    }
    ctx.decision.outcome = outcome

    store.transaction(() => {
      if (ctx.filled) state.setLedger(ctx.ledger)
      state.setPosition(ctx.position)
      if (ctx.record) store.insertDecision(ctx.decision)
      store.insertEquity(tick.tickId, agent.id, ctx.ledger, equityOf(ctx.ledger, price))
    })
    return { agentId: agent.id, outcome, decisionId: ctx.record ? ctx.decision.id : null }
  }

  /** 均线基线：规则给出信号（含止损），不调用 LLM，买入按 100% 交给风控。 */
  private baselineRound(ctx: AgentContext): Outcome {
    const { config, state, decision: d, klines, price, ledger, hasPosition, position, now } = ctx
    const params = baselineParams(config)
    const lock = state.getReentryLock()
    const strategy = evaluate(klines, params, {
      hasPosition,
      price: price.toNumber(),
      entryPrice: position ? position.cost.div(ledger.base).toNumber() : null,
      peakPrice: position ? position.peak.toNumber() : null,
      reentryLocked: lock !== null
    })
    // 短期均线回到长期均线下方，说明止损 / 止盈时的那段行情已经结束，解除买入锁定
    if (lock && strategy.indicators.smaFast <= strategy.indicators.smaSlow) state.setReentryLock(null)
    // 运行间隔通常比 K 线周期短，同一根 K 线会被看到好几轮；同一根 K 线上的同一个信号只处理一次
    const candle = klines.at(-1)!.openTime
    const handled = state.getHandledSignal()
    if (strategy.signal !== 'hold' && handled?.candle === candle && handled.signal === strategy.signal) return 'hold'
    if (strategy.signal === 'hold') return 'hold'
    if (ctx.pause.paused) return 'paused'

    const side = strategy.signal
    ctx.record = true
    d.indicators = { ...strategy.indicators }
    d.signal = side
    d.signalNote = strategy.note
    const pre = precheck(this.riskInput(ctx, side))
    let outcome: Outcome
    if (pre) {
      this.block(d, pre)
      outcome = 'risk_block'
    } else {
      outcome = this.trade(ctx, side, 100)
      // 止损 / 止盈卖出后锁定买入：trend 模式下均线多半还在上方，不锁的话下一根 K 线就会买回去
      if (outcome === 'filled' && (strategy.kind === 'stop_loss' || strategy.kind === 'trailing_stop' || strategy.kind === 'take_profit')) {
        state.setReentryLock({ since: now.toISOString(), reason: strategy.note })
      }
    }
    state.setHandledSignal({ candle, signal: side })
    return outcome
  }

  /**
   * LLM 模型：止损由程序每轮检查；其余由 LLM 决定买入 / 卖出 / 观望和比例，再经过风控。
   * 每根 K 线收盘后只问一次，手动运行不受限制。LLM 没给出合法结果时这根 K 线不算问过，下一轮重试。
   */
  private async llmRound(ctx: AgentContext): Promise<Outcome> {
    const { config, state, decision: d, agent, klines, price, ledger, rules, hasPosition, position, now } = ctx
    const entryPrice = position ? position.cost.div(ledger.base) : null

    const stop = checkStop(config.risk, {
      hasPosition,
      price: price.toNumber(),
      entryPrice: entryPrice?.toNumber() ?? null,
      peakPrice: position?.peak.toNumber() ?? null
    })
    if (stop) {
      if (ctx.pause.paused) return 'paused'
      ctx.record = true
      d.signal = 'sell'
      d.signalNote = stop.note
      const pre = precheck(this.riskInput(ctx, 'sell'))
      if (pre) {
        this.block(d, pre)
        return 'risk_block'
      }
      return this.trade(ctx, 'sell', 100)
    }

    // 暂停时不问 LLM
    if (ctx.pause.paused) return 'paused'

    const slot = this.llmSlot(config, klines)
    if (ctx.trigger === 'schedule' && state.getLlmSlot() === slot.key) return 'hold'

    // 先看买、卖还能不能做：都不能就不浪费一次 LLM 调用，也不算问过，限制解除后下一轮就会问
    const buyBlocked = precheck(this.riskInput(ctx, 'buy'))?.reason ?? null
    const sellBlocked = hasPosition ? precheck(this.riskInput(ctx, 'sell'))?.reason ?? null : '空仓，没有可卖的币'
    if (buyBlocked && sellBlocked) return 'hold'

    const input = buildDecideInput({
      config,
      rules,
      klines,
      price,
      now,
      ledger,
      equity: ctx.equity,
      position,
      blocked: { buy: buyBlocked, sell: sellBlocked },
      recentDecisions: this.deps.store.recentLlmDecisions(ctx.season.id, agent.id, LLM_RECENT_DECISIONS),
      recentFills: this.deps.store.recentFills(ctx.season.id, agent.id, LLM_RECENT_FILLS)
    })

    ctx.record = true
    const result = await this.deps.deciderFor(agent).decide(input)
    const usage = summarizeCalls(result.calls)
    Object.assign(d, {
      signal: result.action,
      signalNote: result.status === 'ok' ? null : `LLM 没有给出合法结果，程序代为观望，下次在 ${fmtUtc(slot.next)} 之前的每一轮都会重试`,
      llmStatus: result.status,
      llmDecision: result.action,
      llmSizePct: result.sizePct,
      llmConfidence: result.confidence,
      llmReason: result.reason,
      llmRaw: result.raw,
      // 错误信息里可能带着服务端回显的内容，先打码再入库
      llmCalls: result.calls.map(c => ({ ...c, error: c.error ? redact(c.error) : null })),
      llmPrompt: result.prompt,
      llmDurationMs: usage.durationMs,
      llmPromptTokens: usage.promptTokens,
      llmCompletionTokens: usage.completionTokens,
      error: result.error ? redact(result.error) : null
    } satisfies Partial<Decision>)
    if (result.status === 'ok') state.setLlmSlot(slot.key)
    if (result.action === 'hold') return 'hold'
    return this.trade(ctx, result.action, result.sizePct)
  }

  /** 当前所在的询问时段：每根 K 线一个。key 带上周期，换了周期就是新的时段 */
  private llmSlot(config: SeasonConfig, klines: Kline[]): { key: string, next: Date } {
    const last = klines.at(-1)!
    const duration = last.closeTime + 1 - last.openTime
    return { key: `candle:${config.klineInterval}:${last.openTime}`, next: new Date(last.closeTime + 1 + duration) }
  }

  private riskInput(ctx: AgentContext, side: 'buy' | 'sell'): PrecheckInput {
    const { store } = this.deps
    const { season, agent, now, ledger } = ctx
    return {
      side,
      price: ctx.price,
      ledger,
      rules: ctx.rules,
      limits: ctx.config.risk,
      tradesToday: store.countFillsSince(season.id, agent.id, `${utcDate(now)}T00:00:00.000Z`),
      lastTradeAt: store.lastFillAt(season.id, agent.id),
      now,
      dayStartEquity: ctx.dayStartEquity,
      equity: ctx.equity,
      circuit: ctx.circuit?.reason ?? null
    }
  }

  private block(d: Decision, r: { rule?: string, reason: string }): void {
    d.riskPassed = false
    d.riskRule = r.rule ?? null
    d.riskReason = r.reason
  }

  /** 风控算出最终金额 / 数量，通过就按快照价格模拟成交，更新上下文里的账本和持仓。 */
  private trade(ctx: AgentContext, side: 'buy' | 'sell', sizePct: number): Outcome {
    const { decision: d, ledger, price, rules } = ctx
    const risk = evaluateRisk({ ...this.riskInput(ctx, side), sizePct })
    Object.assign(d, {
      riskPassed: risk.passed,
      riskRule: risk.rule ?? null,
      riskReason: risk.reason,
      orderSide: risk.passed ? side : null,
      orderQuoteAmount: risk.quoteAmount?.toFixed() ?? null,
      orderQty: risk.quantity?.toFixed() ?? null
    } satisfies Partial<Decision>)
    if (!risk.passed) return 'risk_block'
    // LLM 思考期间（最长几分钟）可能点了暂停，成交前再确认一次
    if (this.deps.store.getPause().paused) return 'paused'

    const fill = paperFill(side, side === 'buy' ? risk.quoteAmount! : risk.quantity!, price, rules)
    if (!fill) {
      this.block(d, { rule: 'min_notional', reason: `最小下单额：按步长取整后成交额低于交易所最小下单额 ${rules.minNotional.toFixed()} USDT` })
      return 'risk_block'
    }
    const after = applyFill(ledger, side, fill)
    const { position, realizedPnl } = updatePosition(ctx.position, side, fill, ledger, after, price, rules)
    ctx.ledger = after
    ctx.position = position
    ctx.filled = true
    Object.assign(d, {
      filledQty: fill.qty.toFixed(),
      filledQuote: fill.quote.toFixed(),
      feeUsdt: fill.fee.toFixed(),
      realizedPnl: realizedPnl?.toFixed() ?? null
    } satisfies Partial<Decision>)
    this.log.info(`${ctx.agent.name}：${side === 'buy' ? '买入' : '卖出'} ${fill.qty.toFixed()} ${rules.baseAsset}，金额 ${fill.quote.toFixed(2)} USDT`)
    return 'filled'
  }

  /** 熔断到期（到了下一个 UTC 日）自动解除；当日亏损达到上限时开始熔断。返回当前的熔断状态 */
  private updateCircuit(state: EntryState, config: SeasonConfig, dayStartEquity: Decimal, equity: Decimal, now: Date, agent: AgentRow): Circuit | null {
    let circuit = state.getCircuit()
    if (circuit && new Date(circuit.until) <= now) {
      circuit = null
      state.setCircuit(null)
    }
    if (circuit) return circuit
    const loss = dailyLossPct(dayStartEquity, equity)
    if (loss.lt(config.risk.dailyLossLimitPct)) return null
    const until = nextUtcMidnight(now)
    circuit = { reason: `今日已亏损 ${loss.toFixed(2)}%（上限 ${config.risk.dailyLossLimitPct}%），${fmtUtc(until)} 前不再买入`, until: until.toISOString() }
    state.setCircuit(circuit)
    this.log.warn(`${agent.name}：当日亏损熔断，${circuit.reason}`)
    return circuit
  }

  private newDecision(tick: TickContext, agent: AgentRow): Decision {
    return {
      id: this.newId(),
      seasonId: tick.season.id,
      agentId: agent.id,
      tickId: tick.tickId,
      createdAt: tick.now.toISOString(),
      price: tick.price.toFixed(),
      indicators: null,
      signal: null,
      signalNote: null,
      llmStatus: null,
      llmDecision: null,
      llmSizePct: null,
      llmConfidence: null,
      llmReason: null,
      llmRaw: null,
      llmCalls: null,
      llmPrompt: null,
      llmDurationMs: null,
      llmPromptTokens: null,
      llmCompletionTokens: null,
      riskPassed: null,
      riskRule: null,
      riskReason: null,
      orderSide: null,
      orderQuoteAmount: null,
      orderQty: null,
      filledQty: null,
      filledQuote: null,
      feeUsdt: null,
      realizedPnl: null,
      outcome: 'hold',
      error: null
    }
  }
}
