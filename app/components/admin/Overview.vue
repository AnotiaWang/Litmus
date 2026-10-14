<script setup lang="ts">
/** 管理概览：运行状态、暂停 / 恢复、立即运行一轮、公开浏览开关；还没配置模型时给出上手步骤。 */
import type { AdminSettingsResponse, AgentAdminView, Outcome, ProviderView, RunResult, StatusResponse } from '#shared/types/api'

const props = defineProps<{
  agents: AgentAdminView[]
  providers: ProviderView[]
}>()
const status = defineModel<StatusResponse | null>('status', { required: true })
const settings = defineModel<AdminSettingsResponse | null>('settings', { required: true })
const emit = defineEmits<{ go: [tab: string] }>()

const { request } = useApi()
const toast = useToast()

const busy = ref<'pause' | 'resume' | 'run' | 'public' | null>(null)
const confirmRun = ref(false)
const lastRun = ref<{ at: Date, error: string | null, outcomes: Array<{ name: string, color: string, outcome: Outcome }> } | null>(null)

const activeLlm = computed(() => props.agents.filter(a => a.kind === 'llm' && a.status === 'active'))
const names = computed(() => new Map(props.agents.map(a => [a.id, a])))

async function act(kind: 'pause' | 'resume') {
  busy.value = kind
  try {
    status.value = await request<StatusResponse>(`/api/admin/${kind}`, { method: 'POST' })
    toast.add({ title: kind === 'pause' ? '已暂停' : '已恢复', color: kind === 'pause' ? 'warning' : 'success' })
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

async function runOnce() {
  confirmRun.value = false
  busy.value = 'run'
  if (status.value) status.value = { ...status.value, running: true }
  try {
    const r = await request<RunResult>('/api/admin/run-once', { method: 'POST' })
    if (r.status === 'busy') {
      toast.add({ title: '已有一轮在运行，请稍后再试', color: 'warning' })
    } else {
      lastRun.value = {
        at: new Date(),
        error: r.error,
        outcomes: r.outcomes.map(o => ({ name: names.value.get(o.agentId)?.name ?? `#${o.agentId}`, color: names.value.get(o.agentId)?.color ?? '#999999', outcome: o.outcome }))
      }
      toast.add({ title: r.error ? '这一轮出错了' : '这一轮运行完成', description: r.error ?? undefined, color: r.error ? 'error' : 'success' })
    }
  } catch (e) {
    toast.add({ title: '运行失败', description: errorMessage(e), color: 'error' })
  } finally {
    busy.value = null
    status.value = await request<StatusResponse>('/api/status').catch(() => status.value)
  }
}

async function setPublic(publicRead: boolean) {
  busy.value = 'public'
  try {
    settings.value = await request<AdminSettingsResponse>('/api/admin/settings', { method: 'PUT', body: { app: { publicRead } } })
    toast.add({ title: publicRead ? '已开启公开浏览' : '已关闭公开浏览', color: 'success' })
  } catch (e) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

const now = ref(Date.now())
watch(status, () => {
  now.value = Date.now()
})
</script>

<template>
  <div class="space-y-6">
    <UCard v-if="activeLlm.length === 0">
      <template #header>
        <h2 class="font-semibold">
          开始使用
        </h2>
      </template>
      <ol class="list-inside list-decimal space-y-2 text-sm">
        <li>
          添加一个 Provider（OpenAI 兼容接口的地址和 Key）
          <UButton
            size="xs"
            variant="link"
            :color="providers.length ? 'neutral' : 'primary'"
            @click="emit('go', 'providers')"
          >
            {{ providers.length ? `已有 ${providers.length} 个` : '去添加' }}
          </UButton>
        </li>
        <li>
          添加要测试的模型，每个模型自动以赛季的初始资金加入当前赛季
          <UButton
            size="xs"
            variant="link"
            @click="emit('go', 'agents')"
          >
            去添加
          </UButton>
        </li>
        <li>等下一轮自动运行，或者在下面点“立即运行一轮”</li>
      </ol>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          运行
        </h2>
      </template>
      <div
        v-if="status"
        class="space-y-4"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <UBadge
              v-if="status.running"
              color="info"
              variant="subtle"
              icon="i-lucide-loader-circle"
              :ui="{ leadingIcon: 'animate-spin' }"
            >
              正在运行这一轮…
            </UBadge>
            <UBadge
              v-else-if="status.paused"
              color="warning"
              variant="subtle"
              icon="i-lucide-circle-pause"
            >
              已暂停{{ status.pausedAt ? `（${fmtTime(status.pausedAt)} 起）` : '' }}
            </UBadge>
            <UBadge
              v-else
              color="success"
              variant="subtle"
              icon="i-lucide-circle-play"
            >
              运行中
            </UBadge>
            <span class="text-muted">
              {{ status.season?.name ?? '没有进行中的赛季' }} ·
              下一轮 {{ fmtDateTime(status.nextRunAt) }}（{{ fmtRelative(status.nextRunAt, now) }}）
              <template v-if="status.lastTick">
                · 上一轮 {{ fmtTime(status.lastTick.at) }}
              </template>
            </span>
          </div>
          <div class="flex shrink-0 gap-2">
            <UButton
              v-if="status.paused"
              color="success"
              icon="i-lucide-play"
              :loading="busy === 'resume'"
              @click="act('resume')"
            >
              恢复
            </UButton>
            <UButton
              v-else
              color="warning"
              variant="soft"
              icon="i-lucide-pause"
              :loading="busy === 'pause'"
              @click="act('pause')"
            >
              暂停
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-zap"
              :loading="busy === 'run' || status.running"
              :disabled="!status.season"
              @click="confirmRun = true"
            >
              立即运行一轮
            </UButton>
          </div>
        </div>
        <p class="text-xs text-muted">
          暂停期间所有模型都不询问 LLM、不交易，止损也不执行；资产照常记录。
        </p>
        <UAlert
          v-if="status.lastTick?.error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="`上一轮（${fmtTime(status.lastTick.at)}）出错`"
          :description="status.lastTick.error"
        />
        <div
          v-if="lastRun"
          class="rounded-md bg-elevated p-3 text-sm"
        >
          <p class="font-medium">
            手动运行结果（{{ lastRun.at.toLocaleTimeString('zh-CN', { hour12: false }) }}）
          </p>
          <p
            v-if="lastRun.error"
            class="mt-1 text-error"
          >
            {{ lastRun.error }}
          </p>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <span
              v-for="o in lastRun.outcomes"
              :key="o.name"
              class="flex items-center gap-1.5"
            >
              <span
                class="size-2 rounded-full"
                :style="{ backgroundColor: o.color }"
              />
              {{ o.name }}
              <UBadge
                size="sm"
                :color="OUTCOMES[o.outcome].color"
                variant="subtle"
              >
                {{ OUTCOMES[o.outcome].label }}
              </UBadge>
            </span>
          </div>
          <UButton
            class="mt-2 px-0"
            size="xs"
            variant="link"
            to="/"
          >
            去排行榜看决策记录
          </UButton>
        </div>
      </div>
    </UCard>

    <UCard v-if="settings">
      <template #header>
        <h2 class="font-semibold">
          站点
        </h2>
      </template>
      <USwitch
        :model-value="settings.app.publicRead"
        :loading="busy === 'public'"
        label="公开浏览"
        :description="settings.app.publicRead
          ? '任何人都能看排行榜、曲线和决策记录（不含 Provider 地址和 Key）；管理页始终需要口令。'
          : '所有页面都需要口令才能查看。'"
        @update:model-value="setPublic"
      />
    </UCard>

    <ConfirmModal
      v-model:open="confirmRun"
      title="立即运行一轮？"
      :description="status?.paused
        ? '当前已暂停：这一轮只记录资产，不询问 LLM、不交易。'
        : '所有参赛模型马上运行一轮：LLM 模型各询问一次（不受每根 K 线一次的限制），按决定模拟成交。'"
      confirm-label="运行"
      icon="i-lucide-zap"
      @confirm="runOnce"
    />
  </div>
</template>
