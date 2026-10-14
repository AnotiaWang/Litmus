<script setup lang="ts">
/**
 * 模型详情：这个模型在所选赛季里的成绩、收益率走势（和均线基线对比）和全部决策记录。
 */
const PAGE_SIZE = 20
const REFRESH_MS = 30_000

const route = useRoute()
const agentId = computed(() => Number(route.params.id))
const seasonId = useSeasonQuery()
const { seasons, status, standings, equity, days, error, refreshing, lastUpdated, season, hasHistory, refresh } = useSeasonData(seasonId)
const { data: decisions, page, onlyActions, loading: decisionsLoading, loaded: decisionsLoaded, newCount, load: loadDecisions, refresh: refreshDecisions } = useDecisions({ seasonId, agentId, pageSize: PAGE_SIZE })

async function refreshAll() {
  await Promise.all([refresh(), (decisionsLoaded.value ? refreshDecisions() : loadDecisions()).catch(() => {})])
}
refreshAll()
usePolling(refreshAll, REFRESH_MS)

const standing = computed(() => standings.value?.standings.find(s => s.agent.id === agentId.value) ?? null)
const agent = computed(() => standing.value?.agent ?? null)

/** 曲线里画这个模型，再加上均线基线做对比 */
const chartAgents = computed(() => {
  const list = standings.value?.standings.map(s => s.agent) ?? []
  return list.filter(a => a.id === agentId.value || (a.kind === 'baseline' && agent.value?.kind !== 'baseline'))
})

const subtitle = computed(() => {
  const a = agent.value
  if (!a) return ''
  if (a.kind === 'baseline') return '均线规则，不调用 LLM'
  return [a.provider, a.model, a.reasoningEffort && `思考强度 ${a.reasoningEffort}`].filter(Boolean).join(' · ')
})

const backTo = computed(() => ({ path: '/', query: seasonId.value ? { season: seasonId.value } : {} }))

useSeoMeta({ title: () => agent.value ? `${agent.value.name} · Litmus` : 'Litmus · LLM 交易决策基准' })
</script>

<template>
  <div class="space-y-6">
    <UButton
      :to="backTo"
      color="neutral"
      variant="link"
      icon="i-lucide-arrow-left"
      class="px-0"
    >
      返回排行榜
    </UButton>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-wifi-off"
      :title="`加载失败：${error}`"
      :actions="[{ label: '重试', color: 'error', variant: 'outline', loading: refreshing, onClick: () => refreshAll() }]"
    />

    <template v-if="season && standings">
      <div
        v-if="agent"
        class="flex flex-wrap items-center gap-3"
      >
        <span
          class="size-4 shrink-0 rounded-full"
          :style="{ backgroundColor: agent.color }"
        />
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-xl font-semibold">
              {{ agent.name }}
            </h1>
            <UBadge
              v-if="agent.kind === 'baseline'"
              color="neutral"
              variant="outline"
            >
              基线
            </UBadge>
            <UBadge
              v-if="agent.status === 'archived'"
              color="neutral"
              variant="subtle"
            >
              已归档
            </UBadge>
          </div>
          <p class="text-sm text-muted">
            {{ subtitle }}
          </p>
        </div>
      </div>

      <SeasonBar
        v-model:season-id="seasonId"
        :seasons="seasons"
        :season="season"
        :status="status"
        :standings="standings"
      />

      <UAlert
        v-if="!standing"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :title="`这个模型没有参加${season.name}`"
        description="可以在上面切换到它参加过的赛季。"
      />

      <template v-else>
        <UAlert
          v-if="standing.circuit"
          color="error"
          variant="subtle"
          icon="i-lucide-shield-alert"
          :title="standing.circuit.reason"
          :description="`当日亏损熔断，${fmtDateTime(standing.circuit.until)} 前只卖不买。`"
        />
        <UAlert
          v-if="standing.leftAt"
          color="neutral"
          variant="subtle"
          icon="i-lucide-log-out"
          :title="`${fmtDateTime(standing.leftAt)} 退出了这个赛季`"
          description="成绩停在退出时，之后不再参与运行。"
        />

        <AgentStats
          :standing="standing"
          :symbol="season.config.symbol"
          :capital="season.config.initialCapital"
        />

        <ReturnChart
          v-if="equity"
          v-model:days="days"
          :points="equity.points"
          :start-price="equity.startPrice"
          :base="equity.base"
          :interval-ms="equity.intervalMs"
          :capital="season.config.initialCapital"
          :agents="chartAgents"
          :symbol="season.config.symbol"
          :has-history="hasHistory"
        />
        <USkeleton
          v-else
          class="h-96 w-full"
        />

        <DecisionTable
          v-if="decisionsLoaded"
          v-model:page="page"
          v-model:only-actions="onlyActions"
          :items="decisions.items"
          :total="decisions.total"
          :loading="decisionsLoading"
          :page-size="PAGE_SIZE"
          :new-count="newCount"
          :symbol="season.config.symbol"
        />
        <USkeleton
          v-else
          class="h-96 w-full"
        />
      </template>

      <p
        v-if="lastUpdated"
        class="text-center text-xs text-muted"
      >
        数据每 {{ REFRESH_MS / 1000 }} 秒自动刷新 · 更新于 {{ lastUpdated.toLocaleTimeString('zh-CN', { hour12: false }) }}
      </p>
    </template>
    <template v-else-if="!error">
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-32 w-full" />
      <USkeleton class="h-96 w-full" />
    </template>
  </div>
</template>
