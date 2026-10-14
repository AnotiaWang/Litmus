<script setup lang="ts">
/**
 * 决策记录表：每条一行，点击展开说明、LLM 理由、风控和成交详情。
 * 传了 agents 时多一列“模型”（排行榜页看所有模型），模型详情页不传。
 */
import type { TableColumn } from '@nuxt/ui'
import type { AgentPublic, DecisionSummary } from '#shared/types/api'
import { RISK_RULE_LABELS, type RiskRule } from '#shared/risk-rules'

const props = defineProps<{
  items: DecisionSummary[]
  total: number
  loading: boolean
  pageSize: number
  /** 不在第 1 页时，自上次加载以来新增的记录数 */
  newCount: number
  symbol: string
  agents?: Map<number, AgentPublic>
  /** 需要自动展开的记录 */
  expandId?: string | null
  title?: string
}>()
const page = defineModel<number>('page', { required: true })
const onlyActions = defineModel<boolean>('onlyActions', { required: true })

const base = computed(() => baseAssetOf(props.symbol))

const columns = computed<TableColumn<DecisionSummary>[]>(() => [
  { accessorKey: 'createdAt', header: '时间' },
  ...(props.agents ? [{ accessorKey: 'agentId', header: '模型' }] : []),
  { accessorKey: 'price', header: '价格' },
  { accessorKey: 'signal', header: '动作' },
  { accessorKey: 'riskPassed', header: '风控' },
  { accessorKey: 'outcome', header: '结果' },
  { id: 'expand', header: '' }
])

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

/** 动作是谁给出的：均线基线带指标；问过 LLM 的有 LLM 状态；其余是程序（止损） */
function source(d: DecisionSummary): string {
  if (d.indicators) return '规则'
  if (d.llmStatus) return 'LLM'
  return '程序'
}

function riskLabel(d: DecisionSummary): string {
  if (d.riskPassed === null) return '-'
  if (d.riskPassed) return '通过'
  return (d.riskRule && RISK_RULE_LABELS[d.riskRule as RiskRule]) || '拦截'
}

function fillText(d: DecisionSummary): string {
  if (d.outcome !== 'filled' || !d.filledQty) return ''
  return `${d.orderSide === 'buy' ? '买入' : '卖出'} ${fmtQty(d.filledQty)} ${base.value}`
}

const agentOf = (id: number) => props.agents?.get(id)
const fmtIndicator = (v: number | undefined) => v === undefined ? '-' : fmtPrice(v)
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="font-semibold">
            {{ title ?? '决策记录' }}
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
          label="只看买卖"
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
        <TermHint :text="GLOSSARY.action">
          动作
        </TermHint>
      </template>
      <template #riskPassed-header>
        <TermHint :text="GLOSSARY.risk">
          风控
        </TermHint>
      </template>
      <template #createdAt-cell="{ row }">
        <span class="whitespace-nowrap">{{ fmtTime(row.original.createdAt) }}</span>
      </template>
      <template #agentId-cell="{ row }">
        <span
          v-if="agentOf(row.original.agentId)"
          class="flex items-center gap-1.5 whitespace-nowrap"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: agentOf(row.original.agentId)!.color }"
          />
          {{ agentOf(row.original.agentId)!.name }}
        </span>
        <span v-else>-</span>
      </template>
      <template #price-cell="{ row }">
        <span class="tabular-nums">{{ fmtPrice(row.original.price) }}</span>
      </template>
      <template #signal-cell="{ row }">
        <div class="flex items-center gap-1">
          <UBadge
            v-if="row.original.signal"
            :color="ACTIONS[row.original.signal].color"
            variant="subtle"
          >
            {{ row.original.llmStatus === 'ok' ? actionText(row.original.signal, row.original.llmSizePct) : ACTIONS[row.original.signal].label }}
          </UBadge>
          <UBadge
            size="sm"
            color="neutral"
            variant="outline"
          >
            {{ source(row.original) }}
          </UBadge>
          <UBadge
            v-if="row.original.llmStatus && row.original.llmStatus !== 'ok'"
            size="sm"
            :color="LLM_STATUS[row.original.llmStatus].color"
            variant="subtle"
          >
            {{ LLM_STATUS[row.original.llmStatus].label }}
          </UBadge>
        </div>
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
          <div v-if="row.original.signalNote || row.original.indicators">
            <p class="font-medium">
              {{ row.original.indicators ? '规则信号' : '程序' }}
            </p>
            <p
              v-if="row.original.signalNote"
              class="text-muted"
            >
              {{ row.original.signalNote }}
            </p>
            <p
              v-if="row.original.indicators"
              class="mt-1 text-muted"
            >
              收盘价 {{ fmtIndicator(row.original.indicators.close) }} ·
              SMA20 {{ fmtIndicator(row.original.indicators.smaFast) }} ·
              SMA50 {{ fmtIndicator(row.original.indicators.smaSlow) }} ·
              RSI14 {{ fmtNumber(row.original.indicators.rsi) }}
            </p>
          </div>
          <div v-if="row.original.llmStatus">
            <p class="font-medium">
              LLM 决策
            </p>
            <p
              v-if="row.original.llmStatus === 'ok' && row.original.llmDecision"
              class="text-muted"
            >
              <span :class="ACTIONS[row.original.llmDecision].className">{{ actionText(row.original.llmDecision, row.original.llmSizePct) }}</span> ·
              <TermHint :text="GLOSSARY.confidence">
                置信度
              </TermHint>
              {{ row.original.llmConfidence }}
            </p>
            <p
              v-else
              class="text-warning"
            >
              {{ LLM_STATUS[row.original.llmStatus].label }}，程序代为观望
            </p>
            <p
              v-if="row.original.llmReason"
              class="mt-1"
            >
              {{ row.original.llmReason }}
            </p>
            <p class="mt-1 text-xs text-muted">
              耗时 {{ fmtDuration(row.original.llmDurationMs) }} · 输入 {{ fmtTokens(row.original.llmPromptTokens) }} / 输出 {{ fmtTokens(row.original.llmCompletionTokens) }} token
            </p>
            <UButton
              class="mt-1 px-0"
              size="xs"
              variant="link"
              icon="i-lucide-brain"
              @click="showLlmDetail(row.original.id)"
            >
              查看思考过程、提示词和调用详情
            </UButton>
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
              计划{{ row.original.orderSide === 'buy' ? `买入 ${fmtNumber(row.original.orderQuoteAmount)} USDT` : `卖出 ${fmtQty(row.original.orderQty)} ${base}` }}
            </p>
          </div>
          <div v-if="row.original.outcome === 'filled'">
            <p class="font-medium">
              成交（模拟撮合）
            </p>
            <p class="text-muted">
              {{ fillText(row.original) }}，按 {{ fmtPrice(row.original.price) }} 成交 {{ fmtNumber(row.original.filledQuote) }} USDT，
              手续费 {{ fmtNumber(row.original.feeUsdt, 4) }} USDT
            </p>
            <p
              v-if="row.original.realizedPnl"
              class="text-muted"
            >
              这部分持仓盈亏（扣除买卖手续费）
              <span :class="pnlClass(row.original.realizedPnl)">{{ Number(row.original.realizedPnl) > 0 ? '+' : '' }}{{ fmtNumber(row.original.realizedPnl) }} USDT</span>
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
      :agents="agents"
    />
  </UCard>
</template>
