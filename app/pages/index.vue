<script setup lang="ts">
/**
 * 首页：赛季信息 → 收益率走势 → 排行榜 → 最近的买卖，定时自动刷新（页面在后台时暂停）。
 */
const PAGE_SIZE = 20
const REFRESH_MS = 30_000

const seasonId = useSeasonQuery()
const { seasons, status, standings, equity, days, error, refreshing, lastUpdated, season, agents, hasHistory, refresh } = useSeasonData(seasonId)
const { data: decisions, page, onlyActions, loading: decisionsLoading, loaded: decisionsLoaded, newCount, load: loadDecisions, refresh: refreshDecisions } = useDecisions({ seasonId, pageSize: PAGE_SIZE, onlyActions: true })

// 决策记录加载失败时不单独提示，上面的错误提示已经说明连不上
async function refreshAll() {
  await Promise.all([refresh(), (decisionsLoaded.value ? refreshDecisions() : loadDecisions()).catch(() => {})])
}
refreshAll()
usePolling(refreshAll, REFRESH_MS)

const chartAgents = computed(() => standings.value?.standings.map(s => s.agent) ?? [])

function backToCurrent() {
  seasonId.value = undefined
}

function openAgent(id: number) {
  navigateTo({ path: `/agents/${id}`, query: seasonId.value ? { season: seasonId.value } : {} })
}

const fmtClock = (d: Date) => d.toLocaleTimeString('zh-CN', { hour12: false })
</script>

<template>
  <div class="space-y-6">
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-wifi-off"
      :title="`加载失败：${error}`"
      :description="lastUpdated ? `下面显示的是 ${fmtClock(lastUpdated)} 的数据。` : undefined"
      :actions="[
        { label: '重试', color: 'error', variant: 'outline', loading: refreshing, onClick: () => refreshAll() },
        ...(seasonId ? [{ label: '回到当前赛季', color: 'neutral' as const, variant: 'outline' as const, onClick: backToCurrent }] : [])
      ]"
    />

    <template v-if="season && standings">
      <SeasonBar
        v-model:season-id="seasonId"
        :seasons="seasons"
        :season="season"
        :status="status"
        :standings="standings"
      />

      <SampleNotice
        :sample="standings.sample"
        :standings="standings.standings"
      />

      <ReturnChart
        v-if="equity"
        v-model:days="days"
        :points="equity.points"
        :start-price="equity.startPrice"
        :base="equity.base"
        :trades="equity.trades"
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

      <RiskChart
        v-if="equity"
        v-model:days="days"
        :points="equity.points"
        :interval-ms="equity.intervalMs"
        :agents="chartAgents"
      />

      <LeaderboardTable
        :standings="standings.standings"
        :sample="standings.sample"
        :loading="false"
        @select="openAgent"
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
        :agents="agents"
      />
      <USkeleton
        v-else
        class="h-96 w-full"
      />

      <p class="text-center text-xs text-muted">
        所有交易都是模拟撮合，资金为虚拟资金。页面时间为本地时间；赛季日切、提示词和风控按 UTC。数据每 {{ REFRESH_MS / 1000 }} 秒自动刷新（页面在后台时暂停）<template v-if="lastUpdated">
          · 更新于 {{ fmtClock(lastUpdated) }}
        </template>
      </p>
    </template>
    <template v-else-if="!error">
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-96 w-full" />
      <USkeleton class="h-64 w-full" />
    </template>
  </div>
</template>
