<script setup lang="ts">
/**
 * 管理页（需要口令）：
 * - 概览：暂停 / 恢复、立即运行一轮、公开浏览开关
 * - 模型：添加、测试、修改显示名 / 颜色、归档、删除
 * - Provider：OpenAI 兼容接口的地址和 Key
 * - 赛季：当前赛季的规则、开始新赛季、改名
 */
import type { AdminSettingsResponse, AgentAdminView, ProviderView, SeasonSummary, StatusResponse } from '#shared/types/api'

const { isAdmin, request } = useApi()
const route = useRoute()
const router = useRouter()

const tabs = [
  { label: '概览', value: 'overview', icon: 'i-lucide-gauge', slot: 'overview' as const },
  { label: '模型', value: 'agents', icon: 'i-lucide-bot', slot: 'agents' as const },
  { label: 'Provider', value: 'providers', icon: 'i-lucide-plug', slot: 'providers' as const },
  { label: '赛季', value: 'seasons', icon: 'i-lucide-flag', slot: 'seasons' as const }
]
const tab = computed({
  get: () => tabs.find(t => t.value === route.query.tab)?.value ?? 'overview',
  set: (v: string | number) => {
    router.replace({ query: { ...route.query, tab: v === 'overview' ? undefined : String(v) } })
  }
})

const providers = ref<ProviderView[]>([])
const agents = ref<AgentAdminView[]>([])
const seasons = ref<SeasonSummary[]>([])
const status = ref<StatusResponse | null>(null)
const settings = ref<AdminSettingsResponse | null>(null)
const loaded = ref(false)
const error = ref('')
const loading = ref(false)

async function loadStatus() {
  status.value = await request<StatusResponse>('/api/status')
}

async function reload() {
  loading.value = true
  try {
    const [p, a, s, st, set] = await Promise.all([
      request<ProviderView[]>('/api/admin/providers'),
      request<AgentAdminView[]>('/api/admin/agents'),
      request<SeasonSummary[]>('/api/seasons'),
      request<StatusResponse>('/api/status'),
      request<AdminSettingsResponse>('/api/admin/settings')
    ])
    providers.value = p
    agents.value = a
    seasons.value = s
    status.value = st
    settings.value = set
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

watch(isAdmin, (v) => {
  if (v) reload()
}, { immediate: true })
// 运行状态变化快（正在运行、下一轮时间），单独刷新
usePolling(() => {
  if (isAdmin.value) loadStatus().catch(() => {})
}, 10_000)

useSeoMeta({ title: '管理 · Litmus' })
</script>

<template>
  <TokenForm
    v-if="!isAdmin"
    title="管理员登录"
    description="管理模型、Provider 和赛季需要口令。"
  />
  <div
    v-else
    class="space-y-6"
  >
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-wifi-off"
      :title="`加载失败：${error}`"
      :actions="[{ label: '重试', color: 'error', variant: 'outline', loading, onClick: reload }]"
    />

    <UTabs
      v-if="loaded"
      v-model="tab"
      :items="tabs"
      variant="link"
      :ui="{ content: 'pt-4' }"
    >
      <template #overview>
        <AdminOverview
          v-model:status="status"
          v-model:settings="settings"
          :agents="agents"
          :providers="providers"
          @go="tab = $event"
        />
      </template>
      <template #agents>
        <AdminAgents
          :agents="agents"
          :providers="providers"
          :running="status?.running ?? false"
          @changed="reload"
          @go="tab = $event"
        />
      </template>
      <template #providers>
        <AdminProviders
          :providers="providers"
          @changed="reload"
        />
      </template>
      <template #seasons>
        <AdminSeasons
          :seasons="seasons"
          :agents="agents"
          :running="status?.running ?? false"
          @changed="reload"
        />
      </template>
    </UTabs>
    <USkeleton
      v-else-if="!error"
      class="h-96 w-full"
    />
  </div>
</template>
