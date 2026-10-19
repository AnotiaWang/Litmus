<script setup lang="ts">
/**
 * 添加 / 修改模型。
 * 添加时选 Provider、填模型名（可以从 Provider 拉取模型列表）、思考强度和额外参数；
 * 这些决定模型“是谁”的字段创建后不能再改，修改时只能改显示名、颜色和超时。
 */
import type { FormError } from '@nuxt/ui'
import { AGENT_COLORS, agentInputSchema, agentUpdateSchema } from '#shared/agents'
import type { AgentAdminView, ProviderView } from '#shared/types/api'

const props = defineProps<{
  agent: AgentAdminView | null
  agents: AgentAdminView[]
  providers: ProviderView[]
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const { request } = useApi()
const toast = useToast()

/** USelect 的选项不能是空字符串，用这个表示“不指定” */
const NO_EFFORT = 'none'
const effortItems = [
  { label: '不指定（用模型默认值）', value: NO_EFFORT },
  ...['minimal', 'low', 'medium', 'high'].map(v => ({ label: v, value: v }))
]

const state = reactive({
  providerId: undefined as number | undefined,
  model: '',
  name: '',
  color: AGENT_COLORS[0] as string,
  reasoningEffort: NO_EFFORT,
  timeoutSeconds: 120,
  inputPricePerM: null as number | null,
  outputPricePerM: null as number | null,
  extraParams: ''
})
/** 显示名是否手动改过；没改过就跟着模型名自动填 */
const nameTouched = ref(false)
const saving = ref(false)

const editing = computed(() => props.agent !== null)
const isBaseline = computed(() => props.agent?.kind === 'baseline')
const providerItems = computed(() => props.providers.map(p => ({ label: p.name, value: p.id })))

watch(open, (v) => {
  if (!v) return
  const a = props.agent
  const used = new Set(props.agents.filter(x => x.status === 'active').map(x => x.color.toLowerCase()))
  Object.assign(state, {
    providerId: a?.providerId ?? props.providers[0]?.id,
    model: a?.model ?? '',
    name: a?.name ?? '',
    color: a?.color ?? AGENT_COLORS.find(c => !used.has(c)) ?? AGENT_COLORS[0],
    reasoningEffort: a?.reasoningEffort ?? NO_EFFORT,
    timeoutSeconds: a?.timeoutSeconds ?? 120,
    inputPricePerM: a?.inputPricePerM ?? null,
    outputPricePerM: a?.outputPricePerM ?? null,
    extraParams: a?.extraParams ? JSON.stringify(a.extraParams, null, 2) : ''
  })
  nameTouched.value = editing.value
  models.value = []
  modelsError.value = ''
})

/** 模型名里斜杠后面的部分做默认显示名，如 openai/gpt-5 → gpt-5 */
watch(() => state.model, (m) => {
  if (!nameTouched.value) state.name = m.trim().split('/').pop() ?? ''
})

// ---------- 从 Provider 拉取模型列表 ----------
const models = ref<string[]>([])
const modelsLoading = ref(false)
const modelsError = ref('')
watch(() => state.providerId, () => {
  models.value = []
  modelsError.value = ''
})

async function fetchModels() {
  if (!state.providerId) return
  modelsLoading.value = true
  modelsError.value = ''
  try {
    models.value = await request<string[]>(`/api/admin/providers/${state.providerId}/models`)
    if (models.value.length === 0) modelsError.value = '这个 Provider 没有返回任何模型，请直接填写模型名。'
  } catch (e) {
    modelsError.value = `${errorMessage(e)}。可以直接填写模型名。`
  } finally {
    modelsLoading.value = false
  }
}

// ---------- 提交 ----------
function parseExtra(text: string): Record<string, unknown> | null | undefined {
  if (!text.trim()) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function body() {
  if (editing.value) {
    return {
      name: state.name,
      color: state.color,
      timeoutSeconds: state.timeoutSeconds,
      inputPricePerM: state.inputPricePerM,
      outputPricePerM: state.outputPricePerM
    }
  }
  return {
    providerId: state.providerId,
    model: state.model,
    name: state.name,
    color: state.color,
    reasoningEffort: state.reasoningEffort === NO_EFFORT ? null : state.reasoningEffort,
    timeoutSeconds: state.timeoutSeconds,
    inputPricePerM: state.inputPricePerM,
    outputPricePerM: state.outputPricePerM,
    extraParams: parseExtra(state.extraParams)
  }
}

function validate(): FormError[] {
  const r = (editing.value ? agentUpdateSchema : agentInputSchema).safeParse(body())
  const errors: FormError[] = r.success ? [] : r.error.issues.map(i => ({ name: String(i.path[0] ?? ''), message: i.message }))
  if (!editing.value && parseExtra(state.extraParams) === undefined) {
    errors.push({ name: 'extraParams', message: '必须是 JSON 对象，如 {"temperature": 0.2}' })
  }
  return errors
}

async function save() {
  saving.value = true
  try {
    if (props.agent) {
      await request(`/api/admin/agents/${props.agent.id}`, { method: 'PATCH', body: body() })
      toast.add({ title: '已保存', color: 'success' })
    } else {
      await request('/api/admin/agents', { method: 'POST', body: body() })
      toast.add({ title: `已添加 ${state.name}`, description: '从下一轮开始参加当前赛季。', color: 'success' })
    }
    open.value = false
    emit('saved')
  } catch (e) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="agent ? `修改 ${agent.name}` : '添加模型'"
    :description="agent ? undefined : '添加后从下一轮开始，以当前赛季的初始资金参赛。'"
  >
    <template #body>
      <UForm
        id="agent-form"
        :state="state"
        :validate="validate"
        :validate-on="['change', 'blur']"
        class="space-y-4"
        @submit="save"
      >
        <template v-if="!editing">
          <UFormField
            name="providerId"
            label="Provider"
            required
          >
            <USelect
              v-model="state.providerId"
              :items="providerItems"
              class="w-full"
            />
          </UFormField>
          <UFormField
            name="model"
            label="模型名"
            description="请求时发送的 model 字段，如 gpt-5、deepseek-chat、anthropic/claude-sonnet-4.5。"
            :help="modelsError || undefined"
            required
          >
            <div class="flex gap-2">
              <UInput
                v-model="state.model"
                class="min-w-0 flex-1"
              />
              <USelectMenu
                v-if="models.length"
                :model-value="state.model"
                :items="models"
                placeholder="从列表选择"
                :search-input="{ placeholder: '搜索模型…' }"
                class="w-48"
                @update:model-value="(v: string) => state.model = v"
              />
              <UButton
                v-else
                color="neutral"
                variant="outline"
                icon="i-lucide-list"
                :loading="modelsLoading"
                :disabled="!state.providerId"
                @click="fetchModels"
              >
                获取模型列表
              </UButton>
            </div>
          </UFormField>
        </template>
        <div
          v-else-if="!isBaseline"
          class="rounded-md bg-elevated p-3 text-sm"
        >
          <p>{{ agent?.provider }} · {{ agent?.model }}{{ agent?.reasoningEffort ? ` · 思考强度 ${agent.reasoningEffort}` : '' }}</p>
          <p class="mt-1 text-xs text-muted">
            Provider、模型名、思考强度和额外参数创建后不能改，否则同一条曲线里混着两个模型。要换请新建一个模型，再把这个归档。
          </p>
        </div>

        <UFormField
          name="name"
          label="显示名"
          required
        >
          <UInput
            v-model="state.name"
            class="w-full"
            @update:model-value="nameTouched = true"
          />
        </UFormField>

        <UFormField
          name="color"
          label="曲线颜色"
        >
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="c in AGENT_COLORS"
              :key="c"
              type="button"
              class="size-7 rounded-full ring-offset-2 ring-offset-default transition"
              :class="state.color.toLowerCase() === c ? 'ring-2 ring-inverted' : 'hover:scale-110'"
              :style="{ backgroundColor: c }"
              :aria-label="c"
              @click="state.color = c"
            />
            <label
              class="relative flex size-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-accented text-muted"
              title="自定义颜色"
            >
              <UIcon
                name="i-lucide-pipette"
                class="size-3.5"
              />
              <input
                v-model="state.color"
                type="color"
                class="absolute inset-0 cursor-pointer opacity-0"
              >
            </label>
            <span class="ml-1 font-mono text-xs text-muted">{{ state.color }}</span>
          </div>
        </UFormField>

        <template v-if="!isBaseline">
          <UFormField
            v-if="!editing"
            name="reasoningEffort"
            label="思考强度"
            description="作为 reasoning_effort 发送；不支持这个参数的模型请选“不指定”。"
          >
            <USelect
              v-model="state.reasoningEffort"
              :items="effortItems"
              class="w-full"
            />
          </UFormField>
          <UFormField
            name="timeoutSeconds"
            label="超时（秒）"
            description="单次请求最多等多久，超时重试 1 次。思考型模型建议给长一些。"
          >
            <UInputNumber
              v-model="state.timeoutSeconds"
              :min="5"
              :max="600"
              class="w-full"
            />
          </UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField
              name="inputPricePerM"
              label="输入单价（USD / 百万 token）"
              description="可选，只用于估算成本，不影响交易。留空则不估算。"
            >
              <UInputNumber
                v-model="state.inputPricePerM"
                :min="0"
                :step="0.01"
                placeholder="例如 3"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="outputPricePerM"
              label="输出单价（USD / 百万 token）"
              description="可选，只用于估算成本，不影响交易。留空则不估算。"
            >
              <UInputNumber
                v-model="state.outputPricePerM"
                :min="0"
                :step="0.01"
                placeholder="例如 15"
                class="w-full"
              />
            </UFormField>
          </div>
          <UFormField
            v-if="!editing"
            name="extraParams"
            label="额外请求参数（可选）"
            description="JSON 对象，原样合并进请求体，用来开启各家不同的思考参数等，如 {&quot;reasoning&quot;: {&quot;enabled&quot;: true}}。"
          >
            <UTextarea
              v-model="state.extraParams"
              :rows="3"
              autoresize
              placeholder="{}"
              class="w-full font-mono"
            />
          </UFormField>
        </template>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          取消
        </UButton>
        <UButton
          type="submit"
          form="agent-form"
          :loading="saving"
        >
          {{ agent ? '保存' : '添加' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
