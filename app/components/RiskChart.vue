<script setup lang="ts">
/**
 * 风险子图：每个模型的回撤或仓位随时间的走势。
 * 回撤是资产从此前最高点回落的幅度；仓位是持币市值占总资产的比例。
 */
import { Chart, Legend, LinearScale, LineElement, PointElement, Tooltip, type ChartData, type ChartOptions } from 'chart.js'
import { Line } from 'vue-chartjs'
import type { AgentPublic, EquityResponse } from '#shared/types/api'
import { alignedTicks, tickLabel, withGaps, type ChartPoint } from '~/utils/chart'

Chart.register(LinearScale, PointElement, LineElement, Tooltip, Legend)

const props = defineProps<{
  points: EquityResponse['points']
  intervalMs: number
  agents: Array<Pick<AgentPublic, 'id' | 'name' | 'color' | 'kind'>>
}>()
const days = defineModel<number>('days', { required: true })

const colorMode = useColorMode()
const mode = ref<'drawdown' | 'exposure'>('drawdown')
const rangeItems = [
  { label: '近 1 天', value: 1 },
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 1 年', value: 365 },
  { label: '全部', value: 3650 }
]

const data = computed<ChartData<'line', ChartPoint[]>>(() => {
  const ts = props.points.map(p => new Date(p.t).getTime())
  const datasets: ChartData<'line', ChartPoint[]>['datasets'] = props.agents.map((agent) => {
    const key = String(agent.id)
    const values: ChartPoint[] = []
    if (mode.value === 'drawdown') {
      let peak = 0
      props.points.forEach((p, i) => {
        const value = Number(p.values[key])
        if (!Number.isFinite(value) || value <= 0) return
        peak = Math.max(peak, value)
        values.push({ x: ts[i]!, y: peak > 0 ? (peak - value) / peak * 100 : 0, v: value })
      })
    } else {
      props.points.forEach((p, i) => {
        const total = Number(p.values[key])
        const qty = Number(p.bases[key] ?? 0)
        if (!Number.isFinite(total) || total <= 0) return
        values.push({ x: ts[i]!, y: qty * Number(p.price) / total * 100, v: qty })
      })
    }
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
  return { datasets }
})

const options = computed<ChartOptions<'line'>>(() => {
  const dark = colorMode.value === 'dark'
  const text = dark ? '#cbd5e1' : '#475569'
  const grid = dark ? 'rgba(148, 163, 184, 0.15)' : 'rgba(100, 116, 139, 0.15)'
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
          label: ctx => `${ctx.dataset.label}：${fmtNumber(ctx.parsed.y, 2)}%`
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
        beginAtZero: true,
        ticks: { color: text, callback: value => `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` },
        grid: { color: grid }
      }
    }
  }
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold">
            回撤与仓位
          </h2>
          <p class="text-xs text-muted">
            回撤越浅越好；仓位越高，收益和回撤通常也越大。和上面的收益曲线使用同一个时间范围。
          </p>
        </div>
        <div class="flex shrink-0 gap-2">
          <USelect
            v-model="mode"
            :items="[{ label: '回撤', value: 'drawdown' }, { label: '仓位', value: 'exposure' }]"
            class="w-24"
          />
          <USelect
            v-model="days"
            :items="rangeItems"
            class="w-28"
          />
        </div>
      </div>
    </template>
    <div
      v-if="points.length < 2"
      class="flex h-56 items-center justify-center px-4 text-center text-sm text-muted"
    >
      还没有足够的数据点。
    </div>
    <div
      v-else
      class="h-56"
    >
      <Line
        :data="data"
        :options="options"
      />
    </div>
  </UCard>
</template>
