<script setup lang="ts">
/**
 * 模型列表：添加、测试、修改显示名 / 颜色 / 超时、归档、删除。
 * 归档后停止参赛、保留成绩，不能恢复；还没参与过运行的模型可以直接删除。
 */
import type { AgentAdminView, AgentTestResult, ProviderView } from '#shared/types/api'

const props = defineProps<{
  agents: AgentAdminView[]
  providers: ProviderView[]
  running: boolean
}>()
const emit = defineEmits<{ changed: [], go: [tab: string] }>()

const { request } = useApi()
const toast = useToast()

const active = computed(() => props.agents.filter(a => a.status === 'active'))
const paused = computed(() => props.agents.filter(a => a.status === 'paused'))
const archived = computed(() => props.agents.filter(a => a.status === 'archived'))

function subtitle(a: AgentAdminView) {
  if (a.kind === 'baseline') return '均线规则，不调用 LLM'
  return [
    a.provider,
    a.model,
    a.reasoningEffort && `思考强度 ${a.reasoningEffort}`,
    a.timeoutSeconds && `超时 ${a.timeoutSeconds} 秒`,
    a.extraParams && `额外参数 ${JSON.stringify(a.extraParams)}`
  ].filter(Boolean).join(' · ')
}

// ---------- 添加 / 修改 ----------
const formOpen = ref(false)
const editing = ref<AgentAdminView | null>(null)
function openCreate() {
  editing.value = null
  formOpen.value = true
}
function openEdit(a: AgentAdminView) {
  editing.value = a
  formOpen.value = true
}

// ---------- 测试 ----------
const testing = ref<AgentAdminView | null>(null)
const testResult = ref<AgentTestResult | null>(null)
const testError = ref('')
const testOpen = ref(false)

async function test(a: AgentAdminView) {
  testing.value = a
  testResult.value = null
  testError.value = ''
  testOpen.value = true
  try {
    testResult.value = await request<AgentTestResult>(`/api/admin/agents/${a.id}/test`, { method: 'POST' })
  } catch (e) {
    testError.value = errorMessage(e)
  }
}

// ---------- 暂停 / 恢复 ----------
const statusBusy = ref<number | null>(null)
async function setStatus(a: AgentAdminView, action: 'pause' | 'resume') {
  statusBusy.value = a.id
  try {
    await request(`/api/admin/agents/${a.id}/${action}`, { method: 'POST' })
    toast.add({ title: action === 'pause' ? `已暂停 ${a.name}` : `已恢复 ${a.name}`, color: action === 'pause' ? 'warning' : 'success' })
    emit('changed')
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  } finally {
    statusBusy.value = null
  }
}

// ---------- 归档 / 删除 ----------
const pending = ref<{ kind: 'archive' | 'delete', agent: AgentAdminView } | null>(null)
const pendingBusy = ref(false)

async function confirmPending() {
  const p = pending.value
  if (!p) return
  pendingBusy.value = true
  try {
    if (p.kind === 'archive') {
      await request(`/api/admin/agents/${p.agent.id}/archive`, { method: 'POST' })
      toast.add({ title: `已归档 ${p.agent.name}`, color: 'success' })
    } else {
      await request(`/api/admin/agents/${p.agent.id}`, { method: 'DELETE' })
      toast.add({ title: `已删除 ${p.agent.name}`, color: 'success' })
    }
    pending.value = null
    emit('changed')
  } catch (e) {
    toast.add({ title: '操作失败', description: errorMessage(e), color: 'error' })
  } finally {
    pendingBusy.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold">
              参赛模型
            </h2>
            <p class="text-xs text-muted">
              新添加的模型从下一轮开始，以当前赛季的初始资金参赛。
            </p>
          </div>
          <UButton
            icon="i-lucide-plus"
            :disabled="providers.length === 0"
            @click="openCreate"
          >
            添加模型
          </UButton>
        </div>
      </template>

      <UAlert
        v-if="providers.length === 0"
        class="m-4 w-auto"
        color="info"
        variant="subtle"
        icon="i-lucide-plug"
        title="先添加一个 Provider"
        description="模型需要挂在一个 OpenAI 兼容接口（Provider）下。"
        :actions="[{ label: '去添加 Provider', color: 'info', variant: 'outline', onClick: () => emit('go', 'providers') }]"
      />

      <ul class="divide-y divide-default">
        <li
          v-for="a in active"
          :key="a.id"
          class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="flex min-w-0 items-start gap-3">
            <span
              class="mt-1.5 size-3 shrink-0 rounded-full"
              :style="{ backgroundColor: a.color }"
            />
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 font-medium">
                {{ a.name }}
                <UBadge
                  v-if="a.kind === 'baseline'"
                  size="sm"
                  color="neutral"
                  variant="outline"
                >
                  基线
                </UBadge>
              </p>
              <p class="text-sm break-all text-muted">
                {{ subtitle(a) }}
              </p>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap gap-1">
            <UButton
              v-if="a.kind === 'llm'"
              color="neutral"
              variant="ghost"
              icon="i-lucide-flask-conical"
              @click="test(a)"
            >
              测试
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-pencil"
              @click="openEdit(a)"
            >
              修改
            </UButton>
            <UButton
              color="warning"
              variant="ghost"
              icon="i-lucide-pause"
              :loading="statusBusy === a.id"
              :disabled="running"
              @click="setStatus(a, 'pause')"
            >
              暂停
            </UButton>
            <UButton
              v-if="a.deletable"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="running"
              @click="pending = { kind: 'delete', agent: a }"
            >
              删除
            </UButton>
            <UButton
              v-else
              color="neutral"
              variant="ghost"
              icon="i-lucide-archive"
              :disabled="running"
              @click="pending = { kind: 'archive', agent: a }"
            >
              归档
            </UButton>
          </div>
        </li>
      </ul>
    </UCard>

    <UCard
      v-if="paused.length"
      :ui="{ body: 'p-0 sm:p-0' }"
    >
      <template #header>
        <h2 class="font-semibold">
          已暂停
        </h2>
        <p class="text-xs text-muted">
          暂停期间不询问 LLM、不交易，止损也不执行，资产照常按当前价记录；恢复后从下一轮继续。
        </p>
      </template>
      <ul class="divide-y divide-default">
        <li
          v-for="a in paused"
          :key="a.id"
          class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="flex min-w-0 items-start gap-3">
            <span
              class="mt-1.5 size-3 shrink-0 rounded-full opacity-70"
              :style="{ backgroundColor: a.color }"
            />
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2 font-medium">
                {{ a.name }}
                <UBadge
                  v-if="a.kind === 'baseline'"
                  size="sm"
                  color="neutral"
                  variant="outline"
                >
                  基线
                </UBadge>
                <UBadge
                  size="sm"
                  color="warning"
                  variant="subtle"
                >
                  已暂停
                </UBadge>
              </p>
              <p class="text-sm break-all text-muted">
                {{ subtitle(a) }}
              </p>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap gap-1">
            <UButton
              color="success"
              variant="ghost"
              icon="i-lucide-play"
              :loading="statusBusy === a.id"
              :disabled="running"
              @click="setStatus(a, 'resume')"
            >
              恢复
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-pencil"
              @click="openEdit(a)"
            >
              修改
            </UButton>
            <UButton
              v-if="a.deletable"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="running"
              @click="pending = { kind: 'delete', agent: a }"
            >
              删除
            </UButton>
            <UButton
              v-else
              color="neutral"
              variant="ghost"
              icon="i-lucide-archive"
              :disabled="running"
              @click="pending = { kind: 'archive', agent: a }"
            >
              归档
            </UButton>
          </div>
        </li>
      </ul>
    </UCard>

    <UCard
      v-if="archived.length"
      :ui="{ body: 'p-0 sm:p-0' }"
    >
      <template #header>
        <h2 class="font-semibold">
          已归档
        </h2>
        <p class="text-xs text-muted">
          不再参赛，历史赛季里的成绩和决策记录保留。
        </p>
      </template>
      <ul class="divide-y divide-default">
        <li
          v-for="a in archived"
          :key="a.id"
          class="flex items-start gap-3 p-4 text-sm"
        >
          <span
            class="mt-1 size-3 shrink-0 rounded-full opacity-60"
            :style="{ backgroundColor: a.color }"
          />
          <div class="min-w-0">
            <p class="font-medium">
              {{ a.name }}
              <span class="ml-1 text-xs font-normal text-muted">{{ a.archivedAt ? `${fmtDateTime(a.archivedAt)} 归档` : '' }}</span>
            </p>
            <p class="break-all text-muted">
              {{ subtitle(a) }}
            </p>
          </div>
        </li>
      </ul>
    </UCard>

    <AdminAgentForm
      v-model:open="formOpen"
      :agent="editing"
      :agents="agents"
      :providers="providers"
      @saved="emit('changed')"
    />

    <UModal
      v-model:open="testOpen"
      :title="`测试 ${testing?.name ?? ''}`"
      description="用当前赛季的行情和一个空仓账本问一次，不记录、不交易。"
      :ui="{ content: 'sm:max-w-3xl' }"
    >
      <template #body>
        <div
          v-if="!testResult && !testError"
          class="flex items-center gap-2 py-8 text-sm text-muted"
        >
          <UIcon
            name="i-lucide-loader-circle"
            class="size-4 animate-spin"
          />
          正在询问 LLM，思考型模型可能要等一两分钟…
        </div>
        <UAlert
          v-else-if="testError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-x"
          title="测试失败"
          :description="testError"
        />
        <div
          v-else-if="testResult"
          class="space-y-4"
        >
          <UAlert
            :color="testResult.ok ? 'success' : 'error'"
            variant="subtle"
            :icon="testResult.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'"
            :title="testResult.ok
              ? `正常：${actionText(testResult.action, testResult.sizePct)}，把握 ${testResult.confidence}，用时 ${fmtDuration(testResult.durationMs)}`
              : `失败（用时 ${fmtDuration(testResult.durationMs)}）`"
            :description="testResult.ok ? testResult.reason : testResult.error ?? undefined"
          />
          <LlmCalls :calls="testResult.calls" />
        </div>
      </template>
    </UModal>

    <ConfirmModal
      :open="pending !== null"
      :title="pending?.kind === 'delete' ? `删除「${pending.agent.name}」？` : `归档「${pending?.agent.name}」？`"
      :description="pending?.kind === 'delete'
        ? '这个模型还没参与过运行，删除后不留任何记录。'
        : '归档后停止参赛，不能恢复；成绩停在最后一次资产快照，持仓不做处理。历史成绩和决策记录保留。'"
      :confirm-label="pending?.kind === 'delete' ? '删除' : '归档'"
      :color="pending?.kind === 'delete' ? 'error' : 'warning'"
      :loading="pendingBusy"
      @update:open="(v: boolean) => { if (!v) pending = null }"
      @confirm="confirmPending"
    />
  </div>
</template>
