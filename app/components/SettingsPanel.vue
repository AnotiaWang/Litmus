<script setup lang="ts">
/**
 * 设置面板：预算、运行间隔、决策方式、止损、风控。保存后马上生效，从下一轮开始使用。
 * 规则模式和 LLM 决策模式各有一组参数，只显示当前选中模式的那一组；另一组的值保留不动，切回去还在。
 * 修改预算会重新开始策略账本，持仓期间不能改（服务端也会再检查一次）。
 */
import type { FormSubmitEvent } from '@nuxt/ui'
import { CONFIRM_BARS_MAX, DEFAULT_SETTINGS, KLINE_INTERVALS, LLM_KLINES_MAX, SMA_SLOW_MAX, settingsSchema, type Settings } from '#shared/settings'
import type { SettingsResponse } from '#shared/types/api'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const { request } = useApi()
const toast = useToast()

/** 表单里金额用数字输入框，提交时由校验规则转回字符串 */
type FormState = Omit<Settings, 'budgetUsdt' | 'maxOrderUsdt'> & { budgetUsdt: number, maxOrderUsdt: number }
const toForm = (s: Settings): FormState => ({ ...s, budgetUsdt: Number(s.budgetUsdt), maxOrderUsdt: Number(s.maxOrderUsdt) })

const loaded = ref<SettingsResponse | null>(null)
const state = ref<FormState>(toForm(DEFAULT_SETTINGS))
const loading = ref(false)
const loadError = ref('')
const saving = ref(false)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    loaded.value = await request<SettingsResponse>('/api/settings')
    state.value = toForm(loaded.value.settings)
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
watch(open, (v) => {
  if (v) load()
})

const budgetChanged = computed(() => loaded.value !== null && state.value.budgetUsdt !== Number(loaded.value.settings.budgetUsdt))

/** 恢复默认值。预算不动：改预算会重新开始账本，要用户自己决定 */
function resetDefaults() {
  state.value = { ...toForm(DEFAULT_SETTINGS), budgetUsdt: state.value.budgetUsdt }
}

async function save(event: FormSubmitEvent<Settings>) {
  saving.value = true
  const restart = budgetChanged.value
  try {
    loaded.value = await request<SettingsResponse>('/api/settings', { method: 'PUT', body: event.data })
    state.value = toForm(loaded.value.settings)
    toast.add({
      title: '设置已保存',
      description: restart ? `策略账本将在下一轮按 ${loaded.value.settings.budgetUsdt} USDT 重新开始` : '从下一轮开始生效',
      color: 'success'
    })
    open.value = false
    emit('saved')
  } catch (e) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

const KLINE_MINUTES = { m: 1, h: 60, d: 1440 } as const
const klineMinutes = (k: string) => Number.parseInt(k) * KLINE_MINUTES[k.at(-1) as keyof typeof KLINE_MINUTES]

/** 运行间隔比 K 线周期短时，提醒中间几轮看到的指标是一样的（只用已收盘的 K 线） */
const intervalHelp = computed(() => {
  const k = state.value.klineInterval
  if (state.value.decisionMode === 'llm' && state.value.llmCadence === 'interval') return undefined
  return state.value.intervalMinutes < klineMinutes(k)
    ? `比 K 线周期（${k}）短：${state.value.decisionMode === 'llm' ? '每根 K 线只问一次 LLM' : '指标只在 K 线收盘后变化'}，中间几轮主要用来检查止损`
    : undefined
})

/** 询问频率比运行间隔还高时，实际每轮问一次 */
const cadenceHelp = computed(() => {
  const { llmCadence, llmIntervalMinutes, intervalMinutes, klineInterval } = state.value
  const every = llmCadence === 'candle' ? klineMinutes(klineInterval) : llmIntervalMinutes
  return every < intervalMinutes ? `比运行间隔（${intervalMinutes} 分钟）还短，实际每轮都会问一次` : undefined
})

const decisionItems = computed(() => [
  { label: '规则策略', value: 'rules', description: '均线 + RSI 按固定规则产生信号，可选 LLM 复核买入' },
  {
    label: 'LLM 决策',
    value: 'llm',
    description: loaded.value?.llmConfigured
      ? 'LLM 直接决定买入 / 卖出 / 观望和比例，不用规则信号'
      : '需要先在 .env 里配置 LLM 连接信息并重启',
    disabled: !loaded.value?.llmConfigured
  }
])
const cadenceItems = [
  { label: '每根 K 线收盘后', value: 'candle' },
  { label: '固定间隔', value: 'interval' }
]

const klineItems = KLINE_INTERVALS.map(k => ({ label: k, value: k }))
const modeItems = [
  { label: '趋势（trend）：看均线当前在上方还是下方', value: 'trend' },
  { label: '交叉（cross）：只在均线交叉的那根 K 线上', value: 'cross' }
]
const money = { maximumFractionDigits: 8, useGrouping: false }
const pct = { maximumFractionDigits: 2 }
</script>

<template>
  <USlideover
    v-model:open="open"
    title="设置"
    description="保存后马上生效，从下一轮开始使用，不用重启。"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <div
        v-if="loading && !loaded"
        class="space-y-3"
      >
        <USkeleton
          v-for="i in 4"
          :key="i"
          class="h-24 w-full"
        />
      </div>

      <UAlert
        v-else-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="加载设置失败"
        :description="loadError"
        :actions="[{ label: '重试', color: 'error', variant: 'outline', onClick: load }]"
      />

      <UForm
        v-else-if="loaded"
        id="settings-form"
        :schema="settingsSchema"
        :state="state"
        class="space-y-8"
        @submit="save"
      >
        <section class="space-y-4">
          <h3 class="font-semibold">
            资金与运行
          </h3>
          <UFormField
            name="budgetUsdt"
            label="策略预算（USDT）"
            :description="loaded.budgetLock ? undefined : '程序只在这笔钱的范围内买卖，Demo 账户里其余的虚拟资金不会动。'"
            :help="loaded.budgetLock ?? undefined"
          >
            <UInputNumber
              v-model="state.budgetUsdt"
              :min="0"
              :step="10"
              :format-options="money"
              :disabled="!!loaded.budgetLock"
              class="w-full"
            />
          </UFormField>
          <UAlert
            v-if="budgetChanged"
            color="warning"
            variant="subtle"
            icon="i-lucide-rotate-ccw"
            title="保存后会重新开始策略账本"
            description="下一轮按新预算重新初始化账本，收益率、“一直持有”基准和资产曲线都从那时起重新计算；之前的决策记录保留。保存前会核对 Demo 账户可用余额是否足够。"
          />
          <UFormField
            name="intervalMinutes"
            label="运行间隔（分钟）"
            description="按整点对齐，例如 15 → :00 :15 :30 :45。"
            :help="intervalHelp"
          >
            <UInputNumber
              v-model="state.intervalMinutes"
              :min="1"
              :max="1440"
              class="w-full"
            />
          </UFormField>
        </section>

        <section class="space-y-4">
          <h3 class="font-semibold">
            决策方式
          </h3>
          <UFormField name="decisionMode">
            <URadioGroup
              v-model="state.decisionMode"
              :items="decisionItems"
              variant="card"
              orientation="horizontal"
              :ui="{ fieldset: 'grid grid-cols-1 gap-2 sm:grid-cols-2', item: 'w-full' }"
            />
          </UFormField>
          <UFormField
            name="klineInterval"
            label="K 线周期"
            :description="state.decisionMode === 'llm' ? '发给 LLM 的 K 线用这个周期' : '均线和 RSI 按这个周期的 K 线计算'"
          >
            <USelect
              v-model="state.klineInterval"
              :items="klineItems"
              class="w-full sm:w-48"
            />
          </UFormField>
        </section>

        <section
          v-if="state.decisionMode === 'rules'"
          class="space-y-4"
        >
          <h3 class="font-semibold">
            规则策略
          </h3>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <UFormField
              name="signalMode"
              label="信号模式"
            >
              <USelect
                v-model="state.signalMode"
                :items="modeItems"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="smaFast"
              label="短期均线（根）"
            >
              <UInputNumber
                v-model="state.smaFast"
                :min="2"
                :max="SMA_SLOW_MAX - 1"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="smaSlow"
              label="长期均线（根）"
              :hint="`最多 ${SMA_SLOW_MAX}`"
            >
              <UInputNumber
                v-model="state.smaSlow"
                :min="3"
                :max="SMA_SLOW_MAX"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="rsiPeriod"
              label="RSI 周期（根）"
            >
              <UInputNumber
                v-model="state.rsiPeriod"
                :min="2"
                :max="50"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="confirmBars"
              label="信号确认（根）"
              :description="state.signalMode === 'trend'
                ? '均线要连续这么多根 K 线都在上方 / 下方才买 / 卖，减少交叉附近来回买卖；1 为不确认'
                : '只对趋势模式生效'"
            >
              <UInputNumber
                v-model="state.confirmBars"
                :min="1"
                :max="CONFIRM_BARS_MAX"
                :disabled="state.signalMode !== 'trend'"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="rsiBuyMax"
              label="买入时 RSI 上限"
              description="RSI 高于此值不买，避免追高"
            >
              <UInputNumber
                v-model="state.rsiBuyMax"
                :min="1"
                :max="100"
                :format-options="pct"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="rsiSellMin"
              label="止盈 RSI"
              description="持仓时 RSI 高于此值就卖出，100 为关闭（默认）。止盈后要等均线先跌破再站上才会买回"
            >
              <UInputNumber
                v-model="state.rsiSellMin"
                :min="1"
                :max="100"
                :format-options="pct"
                class="w-full"
              />
            </UFormField>
          </div>
          <UFormField name="llmEnabled">
            <USwitch
              v-model="state.llmEnabled"
              :disabled="!loaded.llmConfigured"
              label="用 LLM 复核买入信号"
              :description="loaded.llmConfigured
                ? '关闭后规则信号直接进入风控，买入金额按单笔上限。卖出本来就不经过 LLM。'
                : '.env 里没有配置 LLM 连接信息（LLM_BASE_URL、LLM_API_KEY、LLM_MODEL），配置后重启才能开启。'"
            />
          </UFormField>
        </section>

        <section
          v-else
          class="space-y-4"
        >
          <h3 class="font-semibold">
            LLM 决策
          </h3>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <UFormField
              name="llmCadence"
              label="多久问一次 LLM"
              description="没到询问时间的轮次只检查止损；手动运行一次时总会问"
              class="sm:col-span-2"
            >
              <URadioGroup
                v-model="state.llmCadence"
                :items="cadenceItems"
                orientation="horizontal"
              />
            </UFormField>
            <UFormField
              name="llmIntervalMinutes"
              label="询问间隔（分钟）"
              :description="state.llmCadence === 'interval' ? '按整点对齐，例如 60 → 每个整点' : '只在选择固定间隔时生效'"
              :help="cadenceHelp"
            >
              <UInputNumber
                v-model="state.llmIntervalMinutes"
                :min="1"
                :max="1440"
                :disabled="state.llmCadence !== 'interval'"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="llmKlines"
              label="发给 LLM 的 K 线（根）"
              :description="`最近这么多根已收盘 K 线，最多 ${LLM_KLINES_MAX}。越多越贵、越慢`"
            >
              <UInputNumber
                v-model="state.llmKlines"
                :min="10"
                :max="LLM_KLINES_MAX"
                class="w-full"
              />
            </UFormField>
          </div>
        </section>

        <section class="space-y-4">
          <h3 class="font-semibold">
            止损
          </h3>
          <p
            v-if="state.decisionMode === 'llm'"
            class="text-sm text-muted"
          >
            LLM 决策模式下止损仍由程序每轮按当前价检查，跌破就全部卖出，不等 LLM。
          </p>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <UFormField
              name="stopLossPct"
              label="止损（%）"
              description="现价比持仓均价低这么多就卖出，0 为关闭"
            >
              <UInputNumber
                v-model="state.stopLossPct"
                :min="0"
                :max="99"
                :step="0.5"
                :format-options="pct"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="trailingStopPct"
              label="移动止损（%）"
              description="现价比持仓以来最高价低这么多就卖出，0 为关闭"
            >
              <UInputNumber
                v-model="state.trailingStopPct"
                :min="0"
                :max="99"
                :step="0.5"
                :format-options="pct"
                class="w-full"
              />
            </UFormField>
          </div>
        </section>

        <section class="space-y-4">
          <h3 class="font-semibold">
            风控
          </h3>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <UFormField
              name="maxOrderUsdt"
              label="单笔上限（USDT）"
            >
              <UInputNumber
                v-model="state.maxOrderUsdt"
                :min="0"
                :step="10"
                :format-options="money"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="maxPositionPct"
              label="仓位上限（%）"
              description="持币市值最多占账本总资产的比例"
            >
              <UInputNumber
                v-model="state.maxPositionPct"
                :min="1"
                :max="100"
                :format-options="pct"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="maxTradesPerDay"
              label="每日最多成交（笔）"
              description="按 UTC 日计算，只限制买入"
            >
              <UInputNumber
                v-model="state.maxTradesPerDay"
                :min="1"
                :max="1000"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="cooldownMinutes"
              label="冷却时间（分钟）"
              description="距上一笔成交至少隔这么久才买入"
            >
              <UInputNumber
                v-model="state.cooldownMinutes"
                :min="0"
                :max="10080"
                class="w-full"
              />
            </UFormField>
            <UFormField
              name="dailyLossLimitPct"
              label="当日亏损熔断（%）"
              description="当天亏损达到这个比例就暂停买入到 UTC 0 点，卖出（含止损）照常执行"
            >
              <UInputNumber
                v-model="state.dailyLossLimitPct"
                :min="0.01"
                :max="100"
                :step="0.5"
                :format-options="pct"
                class="w-full"
              />
            </UFormField>
          </div>
        </section>
      </UForm>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-undo-2"
          :disabled="!loaded"
          @click="resetDefaults"
        >
          恢复默认（预算不变）
        </UButton>
        <div class="flex gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="open = false"
          >
            取消
          </UButton>
          <UButton
            type="submit"
            form="settings-form"
            icon="i-lucide-save"
            :loading="saving"
            :disabled="!loaded"
          >
            {{ budgetChanged ? '保存并重新开始账本' : '保存' }}
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
