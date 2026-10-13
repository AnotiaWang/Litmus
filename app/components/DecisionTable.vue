<script setup lang="ts">
/**
 * 决策记录表：每轮一行，点击一行展开指标、LLM 理由、风控说明、成交和错误信息。
 */
import type { TableColumn } from '@nuxt/ui'
import type { DecisionSummary, StatusResponse } from '#shared/types/api'
import { RISK_RULE_LABELS, type RiskRule } from '#shared/risk-rules'

const props = defineProps<{
  items: DecisionSummary[]
  total: number
  loading: boolean
  pageSize: number
  /** 不在第 1 页时，自上次加载以来新增的记录数 */
  newCount: number
  strategy?: StatusResponse['strategy']
  /** 需要自动展开的记录（手动运行一次后指向新记录） */
  expandId: string | null
}>()
const page = defineModel<number>('page', { required: true })
const onlyActions = defineModel<boolean>('onlyActions', { required: true })

const terms = computed(() => glossary(props.strategy))

const columns: TableColumn<DecisionSummary>[] = [
  { accessorKey: 'createdAt', header: '时间' },
  { accessorKey: 'price', header: '价格' },
  { accessorKey: 'signal', header: '信号' },
  { accessorKey: 'llmDecision', header: 'LLM 结论' },
  { accessorKey: 'riskPassed', header: '风控' },
  { accessorKey: 'outcome', header: '结果' },
  { id: 'expand', header: '' }
]

const expanded = ref<Record<string, boolean>>({})
watch([page, onlyActions], () => {
  expanded.value = {}
})
watch(() => [props.items, props.expandId] as const, ([items, id]) => {
  if (id && items.some(d => d.id === id)) expanded.value = { ...expanded.value, [id]: true }
})

// LLM 调用详情在侧边抽屉里看，打开时再加载
const detailOpen = ref(false)
const detailId = ref<string | null>(null)
function showLlmDetail(id: string) {
  detailId.value = id
  detailOpen.value = true
}

const isLlmMode = (d: DecisionSummary) => d.mode === 'llm'

/** 规则模式的卖出、LLM 决策模式的止损都不经过 LLM，由程序直接执行 */
const skipsLlm = (d: DecisionSummary) => d.signal === 'sell' && d.llmDecision === null

function riskLabel(d: DecisionSummary): string {
  if (d.riskPassed === null) return '-'
  if (d.riskPassed) return '通过'
  return (d.riskRule && RISK_RULE_LABELS[d.riskRule as RiskRule]) || '拦截'
}

function fillText(d: DecisionSummary): string {
  if (d.outcome !== 'filled' || !d.filledQty) return ''
  const side = d.orderSide === 'BUY' ? '买入' : '卖出'
  return `${side} ${fmtQty(d.filledQty)}，${fmtNumber(d.filledQuote)} USDT`
}

const fmtIndicator = (v: number | undefined) => v === undefined ? '-' : fmtPrice(v)
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="font-semibold">
            决策记录
            <span class="ml-1 text-sm font-normal text-muted">共 {{ total }} 条</span>
          </h2>
          <UButton
            v-if="newCount > 0"
            size="xs"
            variant="soft"
            icon="i-lucide-arrow-up"
            @click="page = 1"
          >
            有 {{ newCount }} 条新记录，回到最新
          </UButton>
        </div>
        <USwitch
          v-model="onlyActions"
          label="只看买卖信号"
        />
      </div>
    </template>

    <UTable
      v-model:expanded="expanded"
      :data="items"
      :columns="columns"
      :loading="loading"
      :get-row-id="(row: DecisionSummary) => row.id"
      empty="暂无记录"
      class="cursor-pointer"
      @select="(_e: Event, row: { toggleExpanded: () => void }) => row.toggleExpanded()"
    >
      <template #signal-header>
        <TermHint :text="terms.signal">
          信号
        </TermHint>
      </template>
      <template #llmDecision-header>
        <TermHint :text="terms.llm">
          LLM 结论
        </TermHint>
      </template>
      <template #riskPassed-header>
        <TermHint :text="terms.risk">
          风控
        </TermHint>
      </template>
      <template #createdAt-cell="{ row }">
        <span class="whitespace-nowrap">{{ fmtTime(row.original.createdAt) }}</span>
        <UBadge
          v-if="row.original.trigger === 'manual'"
          class="ml-1"
          size="sm"
          color="neutral"
          variant="outline"
        >
          手动
        </UBadge>
      </template>
      <template #price-cell="{ row }">
        {{ fmtPrice(row.original.price) }}
      </template>
      <template #signal-cell="{ row }">
        <div
          v-if="row.original.signal"
          class="flex items-center gap-1"
        >
          <UBadge
            :color="SIGNALS[row.original.signal].color"
            variant="subtle"
          >
            {{ SIGNALS[row.original.signal].label }}
          </UBadge>
          <UBadge
            v-if="isLlmMode(row.original)"
            size="sm"
            color="neutral"
            variant="outline"
          >
            {{ row.original.llmDecision ? 'LLM' : '程序' }}
          </UBadge>
        </div>
        <span v-else>-</span>
      </template>
      <template #llmDecision-cell="{ row }">
        <span
          v-if="row.original.llmDecision"
          :class="LLM_DECISIONS[row.original.llmDecision].className"
        >{{ llmDecisionText(row.original) }}</span>
        <span
          v-else-if="skipsLlm(row.original)"
          class="text-muted"
        >不复核</span>
        <span
          v-else
          class="text-muted"
        >-</span>
      </template>
      <template #riskPassed-cell="{ row }">
        <span :class="row.original.riskPassed === false ? 'text-warning' : row.original.riskPassed ? 'text-success' : 'text-muted'">
          {{ riskLabel(row.original) }}
        </span>
      </template>
      <template #outcome-cell="{ row }">
        <div class="flex flex-col items-start gap-1">
          <UBadge
            :color="OUTCOMES[row.original.outcome].color"
            variant="subtle"
          >
            {{ OUTCOMES[row.original.outcome].label }}
          </UBadge>
          <span
            v-if="fillText(row.original)"
            class="text-xs whitespace-nowrap text-muted"
          >{{ fillText(row.original) }}</span>
        </div>
      </template>
      <template #expand-cell="{ row }">
        <UIcon
          name="i-lucide-chevron-down"
          class="size-4 text-muted transition-transform"
          :class="row.getIsExpanded() ? 'rotate-180' : ''"
        />
      </template>

      <template #expanded="{ row }">
        <div class="grid cursor-default gap-4 text-sm whitespace-normal sm:grid-cols-2">
          <div>
            <p class="font-medium">
              {{ isLlmMode(row.original) ? '程序' : '规则信号' }}
            </p>
            <p class="text-muted">
              {{ row.original.signalNote ?? (isLlmMode(row.original) ? '由 LLM 决策，见右侧' : '-') }}
            </p>
            <p
              v-if="row.original.indicators"
              class="mt-1 text-muted"
            >
              收盘价 {{ fmtIndicator(row.original.indicators.close) }} ·
              <TermHint :text="terms.smaFast">
                短期均线{{ strategy ? ` SMA${strategy.smaFast}` : '' }}
              </TermHint>
              {{ fmtIndicator(row.original.indicators.smaFast) }} ·
              <TermHint :text="terms.smaSlow">
                长期均线{{ strategy ? ` SMA${strategy.smaSlow}` : '' }}
              </TermHint>
              {{ fmtIndicator(row.original.indicators.smaSlow) }} ·
              <TermHint :text="terms.rsi">
                RSI{{ strategy?.rsiPeriod ?? '' }}
              </TermHint>
              {{ fmtNumber(row.original.indicators.rsi) }}
            </p>
          </div>
          <div v-if="row.original.llmDecision">
            <p class="font-medium">
              {{ isLlmMode(row.original) ? 'LLM 决策' : 'LLM 复核' }}
            </p>
            <p class="text-muted">
              {{ llmDecisionText(row.original) }} ·
              <TermHint :text="terms.confidence">
                置信度
              </TermHint>
              {{ row.original.llmConfidence }}
            </p>
            <p class="mt-1">
              {{ row.original.llmReason }}
            </p>
            <UButton
              class="mt-1 px-0"
              size="xs"
              variant="link"
              icon="i-lucide-brain"
              @click="showLlmDetail(row.original.id)"
            >
              查看思考过程和调用详情
            </UButton>
          </div>
          <div v-else-if="skipsLlm(row.original)">
            <p class="font-medium">
              LLM 复核
            </p>
            <p class="text-muted">
              {{ isLlmMode(row.original) ? '止损由程序每轮检查，跌破止损线直接全部卖出，不经过 LLM。' : '卖出（包括止损）不经过 LLM，直接按规则执行。' }}
            </p>
          </div>
          <div v-if="row.original.riskReason">
            <p class="font-medium">
              风控
            </p>
            <p class="text-muted">
              {{ row.original.riskPassed ? '通过' : '拦截' }}：{{ row.original.riskReason }}
            </p>
            <p
              v-if="row.original.orderQuoteAmount || row.original.orderQty"
              class="text-muted"
            >
              计划{{ row.original.orderSide === 'BUY' ? `买入 ${fmtNumber(row.original.orderQuoteAmount)} USDT` : `卖出 ${fmtQty(row.original.orderQty)}` }}
            </p>
          </div>
          <div v-if="row.original.orderId">
            <p class="font-medium">
              订单
            </p>
            <p class="text-muted">
              订单号 {{ row.original.orderId }} · 状态 {{ row.original.orderStatus }}
            </p>
            <p class="text-muted">
              成交 {{ fmtQty(row.original.filledQty) }}，金额 {{ fmtNumber(row.original.filledQuote) }} USDT
              <template v-if="row.original.commission">
                · 手续费 {{ row.original.commission }}
              </template>
            </p>
          </div>
          <div
            v-if="row.original.error"
            class="sm:col-span-2"
          >
            <p class="font-medium text-error">
              错误
            </p>
            <p class="text-error">
              {{ row.original.error }}
            </p>
          </div>
          <p class="text-xs text-muted sm:col-span-2">
            记录 ID {{ row.original.id }} · {{ fmtDateTime(row.original.createdAt) }}
          </p>
        </div>
      </template>
    </UTable>

    <div
      v-if="total > pageSize"
      class="flex justify-center border-t border-default p-3"
    >
      <UPagination
        v-model:page="page"
        :total="total"
        :items-per-page="pageSize"
      />
    </div>

    <LlmCallDetails
      v-model:open="detailOpen"
      :decision-id="detailId"
    />
  </UCard>
</template>
