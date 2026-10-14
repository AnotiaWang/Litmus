<script setup lang="ts">
/**
 * 赛季信息：切换赛季、赛季规则（交易对、初始资金、决策周期、风险预设），
 * 当前赛季再加上运行状态（下一轮时间、是否暂停）和最新价格。
 */
import { useIntervalFn } from '@vueuse/core'
import type { SeasonSummary, StandingsResponse, StatusResponse } from '#shared/types/api'

const props = defineProps<{
  seasons: SeasonSummary[]
  season: SeasonSummary
  status: StatusResponse | null
  standings: StandingsResponse | null
}>()
const seasonId = defineModel<number | undefined>('seasonId')

const isCurrent = computed(() => props.season.endedAt === null)
const config = computed(() => props.season.config)

const seasonItems = computed(() => props.seasons.map(s => ({
  label: s.endedAt === null ? `${s.name}（进行中）` : s.name,
  value: s.id
})))
/** 选当前赛季时去掉 URL 里的 ?season=，链接更短，以后开了新赛季也会跟着走 */
const selected = computed({
  get: () => props.season.id,
  set: (id: number) => {
    seasonId.value = props.seasons.find(s => s.id === id)?.endedAt === null ? undefined : id
  }
})

const now = ref(Date.now())
useIntervalFn(() => {
  now.value = Date.now()
}, 15_000)
watch(() => props.status, () => {
  now.value = Date.now()
})

// 本地时钟和服务端可能有几秒误差：“下次”过点了也只说“即将开始”
const nextRunText = computed(() => {
  const t = props.status?.nextRunAt
  return t && new Date(t).getTime() <= now.value ? '即将开始' : fmtRelative(t, now.value)
})

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const period = computed(() => `${fmtDate(props.season.startedAt)} 起${props.season.endedAt ? `，${fmtDate(props.season.endedAt)} 结束` : ''}`)
</script>

<template>
  <UCard>
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <USelect
          v-model="selected"
          :items="seasonItems"
          class="min-w-36"
          aria-label="切换赛季"
        />
        <span class="text-muted">{{ period }}</span>
        <UBadge
          color="neutral"
          variant="outline"
        >
          {{ config.symbol }}
        </UBadge>
        <UBadge
          color="neutral"
          variant="outline"
        >
          每个模型 {{ fmtNumber(config.initialCapital, 0) }} USDT
        </UBadge>
        <UTooltip :text="`每根 ${config.klineInterval} K 线收盘后询问一次 LLM；每 ${config.checkIntervalMinutes} 分钟运行一轮，检查止损、记录资产`">
          <UBadge
            color="neutral"
            variant="outline"
            icon="i-lucide-clock"
          >
            {{ config.klineInterval }} 决策
          </UBadge>
        </UTooltip>
        <UPopover :content="{ side: 'bottom' }">
          <UBadge
            as="button"
            type="button"
            color="neutral"
            variant="outline"
            icon="i-lucide-shield"
            class="cursor-pointer"
          >
            风控：{{ presetLabel(config.riskPreset) }}
          </UBadge>
          <template #content>
            <div class="max-w-72 space-y-1 p-3 text-xs">
              <p
                v-for="f in RISK_FIELDS"
                :key="f.key"
                class="flex justify-between gap-4"
              >
                <TermHint :text="f.help">
                  <span class="text-muted">{{ f.label }}</span>
                </TermHint>
                <span class="tabular-nums">{{ config.risk[f.key] }} {{ f.unit }}</span>
              </p>
            </div>
          </template>
        </UPopover>
        <TermHint :text="GLOSSARY.paper">
          <span class="text-xs text-muted">模拟撮合</span>
        </TermHint>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <template v-if="isCurrent && status">
          <UBadge
            v-if="status.running"
            color="info"
            variant="subtle"
            icon="i-lucide-loader-circle"
            :ui="{ leadingIcon: 'animate-spin' }"
          >
            正在运行这一轮…
          </UBadge>
          <UTooltip
            v-else-if="status.paused"
            :text="`暂停期间不询问 LLM、不交易，资产照常记录${status.pausedAt ? `；${fmtDateTime(status.pausedAt)} 暂停` : ''}`"
          >
            <UBadge
              color="warning"
              variant="subtle"
              icon="i-lucide-circle-pause"
            >
              已暂停
            </UBadge>
          </UTooltip>
          <UBadge
            v-else
            color="success"
            variant="subtle"
            icon="i-lucide-circle-play"
          >
            运行中
          </UBadge>
          <span class="text-muted">
            下一轮
            <UTooltip :text="fmtDateTime(status.nextRunAt)">
              <span>{{ nextRunText }}</span>
            </UTooltip>
          </span>
        </template>
        <UBadge
          v-else-if="!isCurrent"
          color="neutral"
          variant="subtle"
          icon="i-lucide-flag"
        >
          已结束
        </UBadge>
        <span
          v-if="standings?.price"
          class="text-muted"
        >
          {{ isCurrent ? '最新价' : '结束时价格' }}
          <span class="font-medium text-default tabular-nums">{{ fmtPrice(standings.price) }}</span>
          <span class="text-xs">（{{ fmtTime(standings.asOf) }}）</span>
        </span>
        <span
          v-if="standings?.benchmarkReturnPct"
          class="text-muted"
        >
          <TermHint :text="GLOSSARY.benchmark">
            赛季内一直持有 {{ baseAssetOf(config.symbol) }}
          </TermHint>
          <span
            class="ml-1 font-medium tabular-nums"
            :class="pnlClass(standings.benchmarkReturnPct)"
          >{{ fmtPct(standings.benchmarkReturnPct) }}</span>
        </span>
      </div>

      <UAlert
        v-if="isCurrent && status?.lastTick?.error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`最近一轮（${fmtTime(status.lastTick.at)}）出错`"
        :description="status.lastTick.error"
      />
    </div>
  </UCard>
</template>
