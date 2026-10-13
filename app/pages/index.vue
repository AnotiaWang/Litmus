<script setup lang="ts">
/**
 * 面板页面：状态栏 → 账户卡片 → 资产曲线 → 决策记录，定时自动刷新（页面在后台时暂停）。
 * 右上角的齿轮打开设置面板（预算、运行间隔、策略和风控参数）。
 */
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import type { AccountResponse, DecisionsResponse, EquityResponse, RunResult, StatusResponse } from '#shared/types/api'

const PAGE_SIZE = 20
const REFRESH_MS = 30_000

const { token, request } = useApi()
const toast = useToast()

const status = ref<StatusResponse | null>(null)
const account = ref<AccountResponse | null>(null)
const equity = ref<EquityResponse>({ points: [], intervalMs: 0 })
const decisions = ref<DecisionsResponse>({ items: [], total: 0 })
/** 曲线和决策表是否加载过，没加载过时显示骨架屏 */
const loaded = reactive({ equity: false, decisions: false })

const days = ref(30)
const page = ref(1)
const onlyActions = ref(false)
const loadingDecisions = ref(false)
const busy = ref<'pause' | 'resume' | 'run' | null>(null)
const loadError = ref('')
const refreshing = ref(false)
const lastUpdated = ref<Date | null>(null)
/** 不在第 1 页时新增的记录数 */
const newCount = ref(0)
/** 手动运行后自动展开的记录 */
const expandId = ref<string | null>(null)
const settingsOpen = ref(false)

async function loadStatus() {
  status.value = await request<StatusResponse>('/api/status')
}
async function loadAccount() {
  account.value = await request<AccountResponse>('/api/account')
}
async function loadEquity() {
  equity.value = await request<EquityResponse>('/api/equity', { query: { days: days.value } })
  loaded.equity = true
}
/** silent：后台自动刷新时不显示表格的加载条，避免每 30 秒闪一下 */
async function loadDecisions({ silent = false } = {}) {
  if (!silent) loadingDecisions.value = true
  try {
    decisions.value = await request<DecisionsResponse>('/api/decisions', {
      query: { limit: PAGE_SIZE, offset: (page.value - 1) * PAGE_SIZE, only_actions: onlyActions.value }
    })
    loaded.decisions = true
    newCount.value = 0
  } finally {
    loadingDecisions.value = false
  }
}
/** 不在第 1 页时不替换列表（否则新记录会把正在看的行挤走），只数一下新增了几条 */
async function checkNewDecisions() {
  const { total } = await request<DecisionsResponse>('/api/decisions', {
    query: { limit: 1, offset: 0, only_actions: onlyActions.value }
  })
  newCount.value = Math.max(0, total - decisions.value.total)
}

async function refreshAll({ decisions = true } = {}) {
  if (!token.value) return
  refreshing.value = true
  try {
    await Promise.all([
      loadStatus(),
      loadAccount(),
      loadEquity(),
      decisions && (page.value === 1 ? loadDecisions({ silent: true }) : checkNewDecisions())
    ])
    loadError.value = ''
    lastUpdated.value = new Date()
  } catch (e) {
    if (token.value) loadError.value = `刷新失败：${errorMessage(e)}`
  } finally {
    refreshing.value = false
  }
}

// 页面切到后台时暂停刷新，切回来立刻刷新一次
const timer = useIntervalFn(refreshAll, REFRESH_MS)
const visibility = useDocumentVisibility()
watch(visibility, (v) => {
  if (v === 'hidden') {
    timer.pause()
  } else {
    refreshAll()
    timer.resume()
  }
})

watch(token, () => refreshAll(), { immediate: true })
watch(days, () => loadEquity().catch((e) => {
  toast.add({ title: '加载资产曲线失败', description: errorMessage(e), color: 'error' })
}))
watch(onlyActions, () => {
  page.value = 1
})
watch([page, onlyActions], () => loadDecisions().catch((e) => {
  toast.add({ title: '加载决策记录失败', description: errorMessage(e), color: 'error' })
}))

async function act(kind: 'pause' | 'resume') {
  busy.value = kind
  try {
    status.value = await request<StatusResponse>(`/api/${kind}`, { method: 'POST' })
    toast.add({ title: kind === 'pause' ? '已暂停自动交易' : '已恢复自动交易', color: kind === 'pause' ? 'warning' : 'success' })
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

const scrollToDecisions = () => document.getElementById('decisions')?.scrollIntoView({ behavior: 'smooth' })

async function runOnce() {
  busy.value = 'run'
  if (status.value) status.value.running = true
  try {
    const r = await request<RunResult>('/api/run-once', { method: 'POST' })
    if (r.status === 'busy') {
      toast.add({ title: '已有一轮在运行，请稍后再试', color: 'warning' })
    } else {
      expandId.value = r.decisionId
      const o = OUTCOMES[r.outcome]
      toast.add({
        title: `本轮结束：${o.toast ?? o.label}`,
        color: r.outcome === 'error' || r.outcome === 'interrupted' ? 'error' : 'success',
        actions: [{ label: '查看详情', color: 'neutral', variant: 'outline', onClick: scrollToDecisions }]
      })
    }
  } catch (e) {
    toast.add({ title: '运行失败', description: errorMessage(e), color: 'error' })
  } finally {
    busy.value = null
    // 回到第 1 页看新记录。页码变化会触发上面的 watch 加载列表，这里就不再重复加载
    if (page.value !== 1) {
      page.value = 1
      await refreshAll({ decisions: false })
    } else {
      await refreshAll()
    }
  }
}

const fmtClock = (d: Date) => d.toLocaleTimeString('zh-CN', { hour12: false })
</script>

<template>
  <UContainer class="space-y-6 py-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-bold sm:text-2xl">
          Litmus · AI 交易助手
        </h1>
        <UBadge
          color="warning"
          variant="solid"
          size="lg"
          icon="i-lucide-flask-conical"
        >
          Demo 模式 · 虚拟资金
        </UBadge>
      </div>
      <div class="flex items-center gap-1">
        <UTooltip
          v-if="token"
          :text="lastUpdated ? `刷新（数据更新于 ${fmtClock(lastUpdated)}）` : '刷新'"
        >
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            aria-label="刷新"
            :loading="refreshing"
            @click="refreshAll()"
          />
        </UTooltip>
        <UTooltip
          v-if="token"
          text="设置"
        >
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-settings"
            aria-label="设置"
            @click="settingsOpen = true"
          />
        </UTooltip>
        <UButton
          v-if="token"
          color="neutral"
          variant="ghost"
          icon="i-lucide-log-out"
          aria-label="退出"
          @click="token = ''"
        />
        <UColorModeButton />
      </div>
    </header>

    <TokenForm v-if="!token" />

    <template v-else>
      <SettingsPanel
        v-model:open="settingsOpen"
        @saved="refreshAll()"
      />

      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-wifi-off"
        :title="loadError"
        :description="lastUpdated ? `下面显示的是 ${fmtClock(lastUpdated)} 的数据。` : undefined"
        :actions="[{ label: '重试', color: 'error', variant: 'outline', loading: refreshing, onClick: () => refreshAll() }]"
      />

      <StatusBar
        v-if="status"
        :status="status"
        :busy="busy"
        @pause="act('pause')"
        @resume="act('resume')"
        @run="runOnce"
      />
      <USkeleton
        v-else-if="!loadError"
        class="h-20 w-full"
      />

      <AccountCards
        v-if="account"
        :account="account"
      />
      <div
        v-else-if="!loadError"
        class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <USkeleton
          v-for="i in 4"
          :key="i"
          class="h-28"
        />
      </div>

      <EquityChart
        v-if="loaded.equity"
        v-model:days="days"
        :points="equity.points"
        :interval-ms="equity.intervalMs"
        :has-history="account?.ready ?? false"
      />
      <USkeleton
        v-else-if="!loadError"
        class="h-80 w-full"
      />

      <DecisionTable
        v-if="loaded.decisions"
        id="decisions"
        v-model:page="page"
        v-model:only-actions="onlyActions"
        :items="decisions.items"
        :total="decisions.total"
        :loading="loadingDecisions"
        :page-size="PAGE_SIZE"
        :new-count="newCount"
        :strategy="status?.strategy"
        :expand-id="expandId"
      />
      <USkeleton
        v-else-if="!loadError"
        class="h-96 w-full"
      />

      <p class="text-center text-xs text-muted">
        本面板连接的是交易所{{ status?.mode === 'testnet' ? '测试网' : ' Demo Mode' }}，所有资金均为虚拟资金。
        数据每 {{ REFRESH_MS / 1000 }} 秒自动刷新（页面在后台时暂停）<template v-if="lastUpdated">
          · 更新于 {{ fmtClock(lastUpdated) }}
        </template>
      </p>
    </template>
  </UContainer>
</template>
