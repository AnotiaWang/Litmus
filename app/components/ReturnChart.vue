<script setup lang="ts">
/**
 * 收益率曲线：每个模型一条线（资产总值的涨跌），外加一条“一直持有”的虚线。
 * 收益率从所选时间范围的起点算起，每条线都从 0 开始，“近 7 天”看到的就是这 7 天里谁涨得多；
 * 范围覆盖了赛季开头时，按初始资金和赛季第一轮的价格算，和排行榜的收益率一致。
 * 模型是范围内才加入的，从它加入时的初始资金算起。
 *
 * 横轴按真实时间（时间戳）排布，服务停机等造成的断档会在曲线上留出空白，而不是被挤在一起。
 */
import { Chart, Legend, LinearScale, LineElement, PointElement, Tooltip, type ChartData, type ChartOptions } from 'chart.js'
import { Line } from 'vue-chartjs'
import type { AgentPublic, EquityResponse } from '#shared/types/api'

Chart.register(LinearScale, PointElement, LineElement, Tooltip, Legend)

const props = defineProps<{
  points: EquityResponse['points']
  startPrice: string | null
  base: EquityResponse['base']
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
type Point = { x: number, y: number | null, v?: number }

/**
 * 两点间隔超过常规间隔的 3 倍时视为断档，插入空值让曲线断开。
 * 常规间隔取后端给的运行间隔（已乘上抽样步长）和数据里 75% 分位数间隔中较大的一个：
 * 手动运行会在两轮之间多插一个点，只会让间隔变短，运行间隔给了下限，不会把正常间隔误判成断档。
 */
function withGaps(values: Point[], intervalMs: number): Point[] {
  if (values.length < 3) return values
  const diffs = values.slice(1).map((v, i) => v.x - values[i]!.x).sort((a, b) => a - b)
  const threshold = Math.max(intervalMs, diffs[Math.floor(diffs.length * 0.75)]!) * 3
  const out: Point[] = [values[0]!]
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!
    if (values[i]!.x - prev.x > threshold) out.push({ x: (prev.x + values[i]!.x) / 2, y: null })
    out.push(values[i]!)
  }
  return out
}

const pct = (value: number, base: number) => (value / base - 1) * 100

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
  return { datasets }
})

const HOUR = 3_600_000
const TICK_STEPS = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720, 2160].map(h => h * HOUR)

/** 刻度对齐到本地时间的整点 / 0 点，最多 8 个刻度 */
function alignedTicks(min: number, max: number): Array<{ value: number }> {
  const step = TICK_STEPS.find(s => (max - min) / s <= 8) ?? TICK_STEPS.at(-1)!
  const offset = -new Date(min).getTimezoneOffset() * 60_000
  const ticks = []
  for (let t = Math.ceil((min + offset) / step) * step - offset; t <= max; t += step) ticks.push({ value: t })
  return ticks
}

/** 横轴刻度：跨度 1 天内只显示时分，7 天内显示日期和时分，更长只显示日期 */
function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms)
  if (spanMs <= 36 * HOUR) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (spanMs <= 8 * 24 * HOUR) return fmtTime(d.toISOString())
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

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
        filter: item => item.parsed.y !== null,
        itemSort: (a, b) => (b.parsed.y ?? 0) - (a.parsed.y ?? 0),
        callbacks: {
          title: items => items[0] ? fmtDateTime(new Date(items[0].parsed.x!).toISOString()) : '',
          label: (ctx) => {
            const raw = ctx.raw as Point
            // 一直持有是最后一条线
            const detail = ctx.datasetIndex === props.agents.length ? `价格 ${fmtPrice(raw.v)}` : `${fmtNumber(raw.v)} USDT`
            return `${ctx.dataset.label}：${fmtPct(ctx.parsed.y)}（${detail}）`
          }
        }
      }
    },
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
            {{ base.price ? '从所选时间范围的起点算起' : `相对初始资金 ${fmtNumber(capital, 0)} USDT` }} · 虚线为同期一直持有 {{ baseAssetOf(symbol) }}
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
      />
    </div>
  </UCard>
</template>
