<script setup lang="ts">
/** 样本不足提示：避免把几天的收益差异当成模型能力差异 */
import type { SampleStats, Standing } from '#shared/types/api'

const props = defineProps<{
  sample: SampleStats
  standings: Standing[]
}>()

const maxT = computed(() => {
  const values = props.standings
    .map(s => s.returnTStat)
    .filter((v): v is number => typeof v === 'number')
  return values.length ? Math.max(...values.map(Math.abs)) : null
})

const insufficient = computed(() => props.sample.days < 30 || props.sample.trades < 100)
const significant = computed(() => maxT.value !== null && maxT.value >= 1.96)

const description = computed(() => {
  const intro = `已运行 ${fmtNumber(props.sample.days, 1)} 天、${props.sample.rounds} 轮、${props.sample.trades} 笔交易。`
  if (significant.value) {
    return `${intro}已有模型的收益偏离 0 超过常规显著性阈值（最大 |t| = ${fmtNumber(maxT.value, 2)}），但样本仍短，建议继续观察。`
  }
  const t = maxT.value === null ? '-' : fmtNumber(maxT.value, 2)
  return `${intro}收益率差异可能只是噪声（最大 |t| = ${t}；|t| < 1.96 通常视为不显著），建议至少 30 天 / 100 笔交易后再比较。`
})
</script>

<template>
  <UAlert
    v-if="insufficient"
    color="warning"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    title="样本不足，排名暂不可靠"
    :description="description"
  />
</template>
