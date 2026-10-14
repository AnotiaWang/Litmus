<script setup lang="ts">
/** 赛季：当前赛季的规则、开始新赛季、历史赛季列表；赛季名称随时可以改。 */
import type { AgentAdminView, SeasonSummary } from '#shared/types/api'

const props = defineProps<{
  seasons: SeasonSummary[]
  agents: AgentAdminView[]
  running: boolean
}>()
const emit = defineEmits<{ changed: [] }>()

const { request } = useApi()
const toast = useToast()

const current = computed(() => props.seasons.find(s => s.endedAt === null) ?? null)
const history = computed(() => props.seasons.filter(s => s.endedAt !== null).sort((a, b) => b.id - a.id))
const activeCount = computed(() => props.agents.filter(a => a.status === 'active').length)

const formOpen = ref(false)

// ---------- 改名 ----------
const renaming = ref<SeasonSummary | null>(null)
const newName = ref('')
const renameBusy = ref(false)
function openRename(s: SeasonSummary) {
  renaming.value = s
  newName.value = s.name
}
async function rename() {
  if (!renaming.value || !newName.value.trim()) return
  renameBusy.value = true
  try {
    await request(`/api/admin/seasons/${renaming.value.id}`, { method: 'PATCH', body: { name: newName.value } })
    renaming.value = null
    emit('changed')
  } catch (e) {
    toast.add({ title: '改名失败', description: errorMessage(e), color: 'error' })
  } finally {
    renameBusy.value = false
  }
}

function configRows(s: SeasonSummary) {
  const c = s.config
  return [
    { label: '交易对', value: c.symbol },
    { label: '初始资金', value: `${fmtNumber(c.initialCapital)} USDT / 模型` },
    { label: '决策周期', value: `${c.klineInterval} K 线` },
    { label: '运行间隔', value: `${c.checkIntervalMinutes} 分钟` },
    { label: 'LLM 看到的 K 线', value: `${c.llmKlines} 根` },
    { label: '风控', value: presetLabel(c.riskPreset) }
  ]
}
</script>

<template>
  <div class="space-y-6">
    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold">
              {{ current ? current.name : '没有进行中的赛季' }}
              <UButton
                v-if="current"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                aria-label="改名"
                @click="openRename(current)"
              />
            </h2>
            <p
              v-if="current"
              class="text-xs text-muted"
            >
              {{ fmtDateTime(current.startedAt) }} 开始 · 赛季内规则不能改，要换规则请开始新赛季
            </p>
          </div>
          <UTooltip :text="running ? '正在运行一轮，稍后再试' : ''">
            <UButton
              color="warning"
              variant="soft"
              icon="i-lucide-flag"
              :disabled="running"
              @click="formOpen = true"
            >
              开始新赛季
            </UButton>
          </UTooltip>
        </div>
      </template>
      <div
        v-if="current"
        class="space-y-4"
      >
        <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div
            v-for="r in configRows(current)"
            :key="r.label"
          >
            <dt class="text-xs text-muted">
              {{ r.label }}
            </dt>
            <dd class="font-medium">
              {{ r.value }}
            </dd>
          </div>
        </dl>
        <p class="text-xs text-muted">
          {{ riskSummary(current.config.risk) }}
        </p>
      </div>
    </UCard>

    <UCard
      v-if="history.length"
      :ui="{ body: 'p-0 sm:p-0' }"
    >
      <template #header>
        <h2 class="font-semibold">
          历史赛季
        </h2>
      </template>
      <ul class="divide-y divide-default">
        <li
          v-for="s in history"
          :key="s.id"
          class="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="min-w-0">
            <p class="font-medium">
              {{ s.name }}
            </p>
            <p class="text-muted">
              {{ fmtDateTime(s.startedAt) }} – {{ fmtDateTime(s.endedAt!) }} · {{ s.config.symbol }} · {{ s.config.klineInterval }} · {{ presetLabel(s.config.riskPreset) }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-trophy"
              :to="{ path: '/', query: { season: s.id } }"
            >
              查看成绩
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-pencil"
              aria-label="改名"
              @click="openRename(s)"
            />
          </div>
        </li>
      </ul>
    </UCard>

    <AdminSeasonForm
      v-model:open="formOpen"
      :current="current"
      :next-number="seasons.length + 1"
      :active-count="activeCount"
      @saved="emit('changed')"
    />

    <UModal
      :open="renaming !== null"
      title="修改赛季名称"
      @update:open="(v: boolean) => { if (!v) renaming = null }"
    >
      <template #body>
        <form
          id="rename-form"
          @submit.prevent="rename"
        >
          <UInput
            v-model="newName"
            :maxlength="60"
            class="w-full"
            autofocus
          />
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="renaming = null"
          >
            取消
          </UButton>
          <UButton
            type="submit"
            form="rename-form"
            :loading="renameBusy"
            :disabled="!newName.trim()"
          >
            保存
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
