<script setup lang="ts">
/** 样本不足提示：避免把几天的收益差异当成模型能力差异 */
import type { SampleStats, Standing } from '#shared/types/api'

const props = defineProps<{
  sample: SampleStats
  standings: Standing[]
}>()

/**
 * 双侧 5% 显著性在 Bonferroni 修正后的 |t| 阈值（按参与比较的模型数）：同时看好几个模型时，
 * 只要有一个碰巧越过 1.96 的概率会明显变大。超过 10 个按 10 个算，略偏宽松
 */
const THRESHOLDS = [1.96, 1.96, 2.24, 2.39, 2.50, 2.58, 2.64, 2.69, 2.73, 2.77, 2.81]

const tValues = computed(() => props.standings
  .map(s => s.returnTStat)
  .filter((v): v is number => typeof v === 'number'))
const maxT = computed(() => tValues.value.length ? Math.max(...tValues.value.map(Math.abs)) : null)
const threshold = computed(() => THRESHOLDS[Math.min(tValues.value.length, THRESHOLDS.length - 1)]!)

const insufficient = computed(() => props.sample.days < 30 || props.sample.trades < 100)
const significant = computed(() => maxT.value !== null && maxT.value >= threshold.value)

const description = computed(() => {
  const intro = `已运行 ${fmtNumber(props.sample.days, 1)} 天、${props.sample.rounds} 轮、全部模型合计 ${props.sample.trades} 笔交易。`
  const t = maxT.value === null ? '-' : fmtNumber(maxT.value, 2)
  const rule = `超额收益指相对“一直持有”的收益；${tValues.value.length} 个模型同时比较，|t| ≥ ${fmtNumber(threshold.value, 2)} 才算显著`
  if (significant.value) {
    return `${intro}已有模型的超额收益偏离 0 超过显著性阈值（最大 |t| = ${t}；${rule}），但样本仍短，建议继续观察。`
  }
  return `${intro}超额收益的差异可能只是噪声（最大 |t| = ${t}；${rule}），建议至少 30 天 / 100 笔交易后再比较。`
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
