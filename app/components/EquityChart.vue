<script setup lang="ts">
/**
 * 资产曲线：策略账本总值 vs “启动时全部买入并一直持有”的基准。
 *
 * 横轴按真实时间（时间戳）排布，服务停机等造成的断档会在曲线上留出空白，而不是被挤在一起。
 */
import { Chart, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip, type ChartData, type ChartOptions } from 'chart.js'
import { Line } from 'vue-chartjs'
import type { EquityResponse } from '#shared/types/api'

Chart.register(LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

const props = defineProps<{
  points: EquityResponse['points']
  intervalMs: EquityResponse['intervalMs']
  /** 账本是否已经有过数据，用来区分“还没开始运行”和“这个时间范围内数据不足” */
  hasHistory: boolean
}>()
const days = defineModel<number>('days', { required: true })

const colorMode = useColorMode()

const rangeItems = [
  { label: '近 1 天', value: 1 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 1 年', value: 365 }
]

type Point = { x: number, y: number | null }

/**
 * 两点间隔超过常规间隔的 3 倍时视为断档，插入空值让曲线断开。
 * 常规间隔取后端给的运行间隔（已乘上抽样步长）和数据里 75% 分位数间隔中较大的一个：
 * - 手动运行、修改预算后的初始化会在两轮之间多插一个点，只会让间隔变短，单看数据点少时会把正常间隔误判成断档；
 *   运行间隔给了下限，不受这些点影响
 * - 运行间隔调小过的话，旧数据的间隔比现在的运行间隔长，分位数能兜住
 */
function withGaps(values: Array<{ x: number, y: number }>, intervalMs: number): Point[] {
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

const data = computed<ChartData<'line', Point[]>>(() => {
  const ts = props.points.map(p => new Date(p.t).getTime())
  return {
    datasets: [
      {
        label: '策略',
        data: withGaps(props.points.map((p, i) => ({ x: ts[i]!, y: Number(p.total) })), props.intervalMs),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34, 197, 94, 0.1)',
        fill: true,
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 2
      },
      {
        label: '一直持有',
        data: withGaps(props.points.map((p, i) => ({ x: ts[i]!, y: Number(p.benchmark) })), props.intervalMs),
        borderColor: '#f59e0b',
        borderDash: [6, 4],
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 2
      }
    ]
  }
})

const HOUR = 3_600_000
const TICK_STEPS = [1, 2, 3, 6, 12, 24, 48, 168, 336, 720].map(h => h * HOUR)

/** 刻度对齐到本地时间的整点 / 0 点，最多 8 个刻度 */
function alignedTicks(min: number, max: number): Array<{ value: number }> {
  const step = TICK_STEPS.find(s => (max - min) / s <= 8) ?? TICK_STEPS.at(-1)!
  const offset = -new Date(min).getTimezoneOffset() * 60_000
  const ticks = []
  for (let t = Math.ceil((min + offset) / step) * step - offset; t <= max; t += step) ticks.push({ value: t })
  return ticks
}

/** 横轴刻度：1 天内只显示时分，7 天内显示日期和时分，更长只显示日期 */
function tickLabel(ms: number): string {
  const d = new Date(ms)
  if (days.value <= 1) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days.value <= 7) return fmtTime(d.toISOString())
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

const options = computed<ChartOptions<'line'>>(() => {
  const text = colorMode.value === 'dark' ? '#cbd5e1' : '#475569'
  const grid = colorMode.value === 'dark' ? 'rgba(148, 163, 184, 0.15)' : 'rgba(100, 116, 139, 0.15)'
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    spanGaps: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: text } },
      tooltip: {
        filter: item => item.parsed.y !== null,
        callbacks: {
          title: items => items[0] ? fmtDateTime(new Date(items[0].parsed.x!).toISOString()) : '',
          label: ctx => `${ctx.dataset.label}：${fmtNumber(ctx.parsed.y)} USDT`
        }
      }
    },
    scales: {
      x: {
        type: 'linear',
        bounds: 'data',
        ticks: { color: text, maxRotation: 0, callback: value => tickLabel(Number(value)) },
        afterBuildTicks: (axis) => {
          axis.ticks = alignedTicks(axis.min, axis.max)
        },
        grid: { color: grid }
      },
      y: { ticks: { color: text }, grid: { color: grid } }
    }
  }
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-semibold">
          资产曲线
        </h2>
        <USelect
          v-model="days"
          :items="rangeItems"
          class="w-28"
        />
      </div>
    </template>
    <div
      v-if="points.length < 2"
      class="flex h-64 items-center justify-center px-4 text-center text-sm text-muted"
    >
      {{ hasHistory ? '所选时间范围内不足两个数据点。刚开始运行时需要等两轮，否则可以换一个更长的时间范围。' : '还没有数据，至少运行两轮后才会显示曲线' }}
    </div>
    <div
      v-else
      class="h-64 sm:h-80"
    >
      <Line
        :data="data"
        :options="options"
      />
    </div>
  </UCard>
</template>
