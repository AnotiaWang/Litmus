<script setup lang="ts">
/**
 * 收益率曲线：每个模型一条线（资产总值的涨跌），外加一条“一直持有”的虚线。
 * 收益率从所选时间范围的起点算起，每条线都从 0 开始，“近 7 天”看到的就是这 7 天里谁涨得多；
 * 范围覆盖了赛季开头时，按初始资金和赛季第一轮的价格算，和排行榜的收益率一致。
 * 模型是范围内才加入的，从它加入时的初始资金算起。
 *
 * 横轴按真实时间（时间戳）排布，服务停机等造成的断档会在曲线上留出空白，而不是被挤在一起。
 */
import { Chart, Legend, LinearScale, LineElement, PointElement, Tooltip, type Chart as ChartInstance, type ChartData, type ChartOptions, type TooltipItem } from 'chart.js'
import { Line } from 'vue-chartjs'
import type { AgentPublic, EquityResponse, EquityTrade } from '#shared/types/api'
import { alignedTicks, hexToRgba, tickLabel, withGaps, type ChartPoint } from '~/utils/chart'

Chart.register(LinearScale, PointElement, LineElement, Tooltip, Legend)

const props = defineProps<{
  points: EquityResponse['points']
  startPrice: string | null
  base: EquityResponse['base']
  trades?: EquityTrade[]
  intervalMs: number
  /** 初始资金：范围开始前还没有资产记录的模型，以它为收益率的分母 */
  capital: string
  /** 要画的模型，按这个顺序排列图例 */
  agents: Array<Pick<AgentPublic, 'id' | 'name' | 'color' | 'kind'>>
  symbol: string
  /** 赛季里是否已经有过数据，用来区分“还没开始运行”和“这个时间范围内数据不足” */
  hasHistory: boolean
  title?: string
}>()
const days = defineModel<number>('days', { required: true })

const colorMode = useColorMode()

const rangeItems = [
  { label: '近 1 天', value: 1 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 1 年', value: 365 },
  { label: '全部', value: 3650 }
]

/** v：提示框里显示的原始值（模型是资产 USDT，一直持有是价格） */
type Point = ChartPoint
type TradePoint = ChartPoint & { trade: EquityTrade, agentName: string, color: string }
interface HoldingBand { start: number, end: number, color: string, lane: number }

const pct = (value: number, base: number) => (value / base - 1) * 100

const agentById = computed(() => new Map(props.agents.map(a => [a.id, a])))

/** 把成交按时间对齐到最近的资产点，y 用当时的收益率 */
const tradePoints = computed(() => {
  const out: { buy: TradePoint[], sell: TradePoint[] } = { buy: [], sell: [] }
  for (const trade of props.trades ?? []) {
    const agent = agentById.value.get(trade.agentId)
    if (!agent) continue
    const t = new Date(trade.t).getTime()
    const point = props.points.find(p => new Date(p.t).getTime() === t)
      ?? props.points.find(p => new Date(p.t).getTime() >= t)
      ?? props.points.at(-1)
    if (!point) continue
    const key = String(trade.agentId)
    const value = point.values[key]
    if (value === undefined) continue
    const from = props.base.values[key] !== undefined ? Number(props.base.values[key]) : Number(props.capital)
    out[trade.side].push({
      x: new Date(point.t).getTime(),
      y: pct(Number(value), from),
      v: Number(value),
      trade,
      agentName: agent.name,
      color: agent.color
    })
  }
  return out
})

/** 持仓区间：从持币数量由 0 变成正数开始，到回到 0 结束；部分卖出不会中断 */
const holdingBands = computed<HoldingBand[]>(() => {
  const bands: HoldingBand[] = []
  const lastT = props.points.at(-1) ? new Date(props.points.at(-1)!.t).getTime() : 0
  props.agents.forEach((agent, lane) => {
    const trades = (props.trades ?? [])
      .filter(t => t.agentId === agent.id)
      .sort((a, b) => a.t.localeCompare(b.t))
    const firstT = props.points[0] ? new Date(props.points[0].t).getTime() : 0
    let qty = Number(props.points[0]?.bases[String(agent.id)] ?? 0)
    let start: number | null = qty > 1e-9 ? firstT : null
    for (const trade of trades) {
      const before = qty
      qty += trade.side === 'buy' ? Number(trade.qty) : -Number(trade.qty)
      const time = new Date(trade.t).getTime()
      if (before <= 1e-9 && qty > 1e-9 && start === null) start = time
      else if (before > 1e-9 && qty <= 1e-9 && start !== null) {
        bands.push({ start, end: time, color: agent.color, lane })
        start = null
      }
    }
    if (start !== null && lastT > start) bands.push({ start, end: lastT, color: agent.color, lane })
  })
  return bands
})

/** 在图表底部画每个模型的持仓色条，不遮挡收益曲线 */
const holdingBandsPlugin = {
  id: 'holdingBands',
  afterDraw(chart: ChartInstance) {
    const options = chart.options.plugins as unknown as { holdingBands?: { bands?: HoldingBand[] } } | undefined
    const bands = options?.holdingBands?.bands ?? []
    if (!bands.length) return
    const area = chart.chartArea
    const x = chart.scales.x
    if (!x) return
    const ctx = chart.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(area.left, area.top, area.width, area.height)
    ctx.clip()
    for (const band of bands) {
      const x1 = Math.max(area.left, x.getPixelForValue(band.start))
      const x2 = Math.min(area.right, x.getPixelForValue(band.end))
      if (x2 <= x1) continue
      ctx.fillStyle = hexToRgba(band.color, 0.7)
      ctx.fillRect(x1, area.bottom - 5 - band.lane * 7, x2 - x1, 4)
    }
    ctx.restore()
  }
}

const data = computed<ChartData<'line', Point[]>>(() => {
  const ts = props.points.map(p => new Date(p.t).getTime())
  const capital = Number(props.capital)
  const { base } = props
  const text = colorMode.value === 'dark' ? '#e2e8f0' : '#334155'
  const datasets: ChartData<'line', Point[]>['datasets'] = props.agents.map((agent) => {
    const key = String(agent.id)
    const from = base.values[key] !== undefined ? Number(base.values[key]) : capital
    const values: Point[] = []
    props.points.forEach((p, i) => {
      const v = p.values[key]
      if (v !== undefined) values.push({ x: ts[i]!, y: pct(Number(v), from), v: Number(v) })
    })
    return {
      label: agent.name,
      data: withGaps(values, props.intervalMs),
      borderColor: agent.color,
      backgroundColor: agent.color,
      borderWidth: agent.kind === 'baseline' ? 1.5 : 2,
      pointRadius: 0,
      pointHoverRadius: 3
    }
  })
  const holdFrom = base.price ?? props.startPrice
  if (holdFrom) {
    const start = Number(holdFrom)
    datasets.push({
      label: `一直持有 ${baseAssetOf(props.symbol)}`,
      data: withGaps(props.points.map((p, i) => ({ x: ts[i]!, y: pct(Number(p.price), start), v: Number(p.price) })), props.intervalMs),
      borderColor: text,
      backgroundColor: text,
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 3
    })
  }

  for (const [side, label, pointStyle] of [
    ['buy', '买入', 'triangle'],
    ['sell', '卖出', 'rectRot']
  ] as const) {
    const items = tradePoints.value[side]
    if (!items.length) continue
    datasets.push({
      label,
      data: items,
      showLine: false,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointStyle,
      pointBackgroundColor: items.map(i => i.color),
      pointBorderColor: '#ffffff',
      pointBorderWidth: 1,
      borderWidth: 0,
      order: 0
    } as ChartData<'line', Point[]>['datasets'][number])
  }
  return { datasets }
})

const options = computed<ChartOptions<'line'>>(() => {
  const dark = colorMode.value === 'dark'
  const text = dark ? '#cbd5e1' : '#475569'
  const grid = dark ? 'rgba(148, 163, 184, 0.15)' : 'rgba(100, 116, 139, 0.15)'
  const zero = dark ? 'rgba(203, 213, 225, 0.5)' : 'rgba(71, 85, 105, 0.5)'
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    spanGaps: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: {
        position: 'bottom',
        labels: { color: text, boxWidth: 14, boxHeight: 3, padding: 14 }
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        filter: (item: TooltipItem<'line'>) => item.parsed.y !== null,
        itemSort: (a: TooltipItem<'line'>, b: TooltipItem<'line'>) => (b.parsed.y ?? 0) - (a.parsed.y ?? 0),
        callbacks: {
          title: (items: TooltipItem<'line'>[]) => items[0] ? fmtDateTime(new Date(items[0].parsed.x!).toISOString()) : '',
          label: (ctx: TooltipItem<'line'>) => {
            const raw = ctx.raw as TradePoint & Point
            if (raw.trade) {
              const side = raw.trade.side === 'buy' ? '买入' : '卖出'
              const pnl = raw.trade.realizedPnl === null ? '' : `，已实现 ${fmtNumber(raw.trade.realizedPnl)} USDT`
              return `${raw.agentName} ${side} ${fmtQty(raw.trade.qty)} ${baseAssetOf(props.symbol)} @ ${fmtPrice(raw.trade.price)}${pnl}`
            }
            // 一直持有是资产线之后、买卖点之前的那条虚线
            const detail = ctx.datasetIndex === props.agents.length ? `价格 ${fmtPrice(raw.v)}` : `${fmtNumber(raw.v)} USDT`
            return `${ctx.dataset.label}：${fmtPct(ctx.parsed.y)}（${detail}）`
          }
        }
      },
      holdingBands: { bands: holdingBands.value }
    } as unknown as ChartOptions<'line'>['plugins'],
    scales: {
      x: {
        type: 'linear',
        bounds: 'data',
        ticks: {
          color: text,
          maxRotation: 0,
          callback(value) {
            return tickLabel(Number(value), this.max - this.min)
          }
        },
        afterBuildTicks: (axis) => {
          axis.ticks = alignedTicks(axis.min, axis.max)
        },
        grid: { color: grid }
      },
      y: {
        ticks: { color: text, callback: value => `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%` },
        // 0% 那条线加深，一眼看出谁在赚、谁在亏
        grid: { color: ctx => ctx.tick?.value === 0 ? zero : grid }
      }
    }
  }
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold">
            {{ title ?? '收益率走势' }}
          </h2>
          <p class="text-xs text-muted">
            {{ base.price ? '从所选时间范围的起点算起' : `相对初始资金 ${fmtNumber(capital, 0)} USDT` }} · 虚线为同期一直持有 {{ baseAssetOf(symbol) }} · 三角/方块为买卖，底部色条为持仓区间
          </p>
        </div>
        <USelect
          v-model="days"
          :items="rangeItems"
          class="w-28 shrink-0"
        />
      </div>
    </template>
    <div
      v-if="points.length < 2"
      class="flex h-72 items-center justify-center px-4 text-center text-sm text-muted"
    >
      {{ hasHistory ? '所选时间范围内不足两个数据点，换一个更长的时间范围看看。' : '还没有数据，至少运行两轮后才会显示曲线。' }}
    </div>
    <div
      v-else
      class="h-72 sm:h-96"
    >
      <Line
        :data="data"
        :options="options"
        :plugins="[holdingBandsPlugin]"
      />
    </div>
  </UCard>
</template>
