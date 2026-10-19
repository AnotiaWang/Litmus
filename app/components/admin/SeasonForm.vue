<script setup lang="ts">
/**
 * 开始新赛季：结束当前赛季，所有参赛中的模型按新配置从初始资金重新开始。
 * 表单默认填当前赛季的配置；风险选预设时用预设的值，选“自定义”才能逐项填写。
 * 运行间隔和 K 线根数一般不用改，收在“高级设置”里，校验出错时自动展开。
 */
import { KLINE_INTERVALS, LLM_KLINES_MAX, RISK_PRESETS, RISK_PRESET_LABELS, seasonConfigSchema, type RiskPreset, type SeasonConfig } from '#shared/settings'
import type { SeasonSummary } from '#shared/types/api'
import type { FormErrorEvent } from '@nuxt/ui'

const props = defineProps<{
  current: SeasonSummary | null
  nextNumber: number
  activeCount: number
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const { request } = useApi()
const toast = useToast()

const PRESET_HINTS: Record<RiskPreset, string> = {
  conservative: '护栏最紧，各模型结果更接近，测的更多是风控',
  moderate: '折中',
  aggressive: '只保留基本止损和熔断，结果最能体现模型自己的判断（推荐）',
  custom: '逐项填写'
}
const presets = Object.keys(RISK_PRESET_LABELS) as RiskPreset[]

type FormState = Omit<SeasonConfig, 'initialCapital'> & { name: string, initialCapital: number }
const state = ref<FormState>(toForm(seasonConfigSchema.parse({}), ''))
const saving = ref(false)
const advancedOpen = ref(false)
const ADVANCED_FIELDS = ['checkIntervalMinutes', 'llmKlines']

function toForm(c: SeasonConfig, name: string): FormState {
  return { ...c, name, initialCapital: Number(c.initialCapital), risk: { ...c.risk } }
}

watch(open, (v) => {
  if (!v) return
  state.value = toForm(props.current?.config ?? seasonConfigSchema.parse({}), `第 ${props.nextNumber} 赛季`)
  advancedOpen.value = false
})

function onError(e: FormErrorEvent) {
  if (e.errors.some(err => err.name && ADVANCED_FIELDS.includes(err.name))) advancedOpen.value = true
}

function pickPreset(p: RiskPreset) {
  state.value.riskPreset = p
  if (p !== 'custom') state.value.risk = { ...RISK_PRESETS[p] }
}

const klineMinutes: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720, '1d': 1440 }
const askPerDay = computed(() => Math.round(1440 / klineMinutes[state.value.klineInterval]!))
const coverageHours = computed(() => state.value.llmKlines * klineMinutes[state.value.klineInterval]! / 60)
const fastCadence = computed(() => klineMinutes[state.value.klineInterval]! < 60)
const intervalMismatch = computed(() => {
  const k = klineMinutes[state.value.klineInterval]!
  if (state.value.checkIntervalMinutes < k) return `运行间隔比决策周期短：每根 K 线会运行 ${Math.round(k / state.value.checkIntervalMinutes)} 轮，但只询问一次 LLM。`
  if (state.value.checkIntervalMinutes > k) return '运行间隔比决策周期长：会跳过部分 K 线，LLM 不会在每个 K 线收盘后被询问。'
  return ''
})

async function save() {
  saving.value = true
  try {
    const { name, ...config } = state.value
    const s = await request<SeasonSummary>('/api/admin/seasons', { method: 'POST', body: { name, config } })
    toast.add({ title: `${s.name} 开始了`, description: '下一轮起所有模型从初始资金重新开始。', color: 'success' })
    open.value = false
    emit('saved')
  } catch (e) {
    toast.add({ title: '开始新赛季失败', description: errorMessage(e), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="开始新赛季"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <UForm
        id="season-form"
        :schema="seasonConfigSchema"
        :state="state"
        class="space-y-6"
        @submit="save"
        @error="onError"
      >
        <UAlert
          v-if="current"
          color="warning"
          variant="subtle"
          icon="i-lucide-flag"
          :title="`${current.name}会就此结束`"
          :description="`${activeCount} 个参赛中的模型都从初始资金重新开始，旧赛季的持仓留在旧赛季里不再变化。旧赛季的成绩和记录可以随时切换回去查看。`"
        />

        <section class="grid gap-4 sm:grid-cols-2">
          <UFormField
            name="name"
            label="赛季名称"
            class="sm:col-span-2"
          >
            <UInput
              v-model="state.name"
              class="w-full"
            />
          </UFormField>
          <UFormField
            name="symbol"
            label="交易对"
            description="以 USDT 计价的现货，行情来自 Binance。"
          >
            <UInput
              v-model="state.symbol"
              class="w-full"
              @update:model-value="(v: string) => state.symbol = v.toUpperCase()"
            />
          </UFormField>
          <UFormField
            name="initialCapital"
            label="每个模型的初始资金（USDT）"
            description="所有模型相同，模拟撮合不需要真实资金。"
          >
            <UInputNumber
              v-model="state.initialCapital"
              :min="1"
              :step="100"
              class="w-full"
            />
          </UFormField>
          <UFormField
            name="klineInterval"
            label="决策周期（K 线）"
            :description="`每根 K 线收盘后问每个模型一次，约每天 ${askPerDay} 次；推荐 1h 或 4h。`"
          >
            <USelect
              v-model="state.klineInterval"
              :items="[...KLINE_INTERVALS]"
              class="w-full"
            />
          </UFormField>
        </section>

        <UAlert
          v-if="fastCadence"
          color="warning"
          variant="subtle"
          icon="i-lucide-gauge"
          title="高频决策的成本和噪声都更高"
          :description="`${state.klineInterval} 每天约询问 ${askPerDay} 次/模型，乘上参赛模型数就是总调用量。15m/30m 的信号更容易被噪声主导，token 和延迟也更高；建议优先用 1h 或 4h。`"
        />
        <UAlert
          v-if="coverageHours < 24"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          :description="`发给 LLM 的 ${state.llmKlines} 根 ${state.klineInterval} K 线只覆盖约 ${fmtNumber(coverageHours, 1)} 小时，系统会自动附加最近 14 根日线补足长周期。`"
        />
        <UAlert
          v-if="intervalMismatch"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock"
          :description="intervalMismatch"
        />

        <section class="space-y-3">
          <div>
            <h3 class="font-semibold">
              风控
            </h3>
            <p class="text-xs text-muted">
              程序在模型的决定之上执行的限制，只会调小金额或拦下交易。所有模型（含基线）用同一套。
            </p>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="p in presets"
              :key="p"
              type="button"
              class="rounded-md border p-3 text-left text-sm transition"
              :class="state.riskPreset === p ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated'"
              @click="pickPreset(p)"
            >
              <span class="font-medium">{{ RISK_PRESET_LABELS[p] }}</span>
              <span class="mt-0.5 block text-xs text-muted">{{ PRESET_HINTS[p] }}</span>
              <span
                v-if="p !== 'custom'"
                class="mt-1 block text-xs text-dimmed"
              >{{ riskSummary(RISK_PRESETS[p]) }}</span>
            </button>
          </div>
          <div
            v-if="state.riskPreset === 'custom'"
            class="grid gap-4 sm:grid-cols-2"
          >
            <UFormField
              v-for="f in RISK_FIELDS"
              :key="f.key"
              :name="`risk.${f.key}`"
              :label="`${f.label}（${f.unit}）`"
              :description="f.help"
            >
              <UInputNumber
                v-model="state.risk[f.key]"
                :min="0"
                class="w-full"
              />
            </UFormField>
          </div>
        </section>

        <UCollapsible v-model:open="advancedOpen">
          <UButton
            color="neutral"
            variant="link"
            class="group px-0"
            trailing-icon="i-lucide-chevron-down"
            :ui="{ trailingIcon: 'transition-transform group-data-[state=open]:rotate-180' }"
          >
            高级设置
            <span class="text-xs font-normal text-muted">运行间隔 {{ state.checkIntervalMinutes }} 分钟 · 发给 LLM {{ state.llmKlines }} 根 K 线</span>
          </UButton>
          <template #content>
            <div class="grid gap-4 pt-3 sm:grid-cols-2">
              <UFormField
                name="checkIntervalMinutes"
                label="运行间隔（分钟）"
                description="按整点对齐。两次询问之间的轮次只检查止损、记录资产。"
              >
                <UInputNumber
                  v-model="state.checkIntervalMinutes"
                  :min="1"
                  :max="1440"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                name="llmKlines"
                label="发给 LLM 的 K 线根数"
                :description="`10 到 ${LLM_KLINES_MAX}，越多提示词越长。`"
              >
                <UInputNumber
                  v-model="state.llmKlines"
                  :min="10"
                  :max="LLM_KLINES_MAX"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>
        </UCollapsible>
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
          form="season-form"
          color="warning"
          icon="i-lucide-flag"
          :loading="saving"
        >
          开始新赛季
        </UButton>
      </div>
    </template>
  </UModal>
</template>
