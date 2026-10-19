<script setup lang="ts">
/**
 * 排行榜：按收益率从高到低。点击一行进入模型详情。
 */
import type { TableColumn } from '@nuxt/ui'
import type { SampleStats, Standing } from '#shared/types/api'

defineProps<{
  standings: Standing[]
  loading: boolean
  sample?: SampleStats
}>()
const emit = defineEmits<{ select: [agentId: number] }>()

const columns: TableColumn<Standing>[] = [
  { id: 'rank', header: '#' },
  { id: 'agent', header: '模型' },
  { accessorKey: 'returnPct', header: '收益' },
  { id: 'risk', header: '风险' },
  { id: 'pnl', header: '盈亏' },
  { id: 'trades', header: '交易' },
  { id: 'llm', header: 'LLM' }
]

function agentSubtitle(s: Standing): string {
  const a = s.agent
  if (a.kind === 'baseline') return '均线规则，不调用 LLM'
  return [a.provider, a.model, a.reasoningEffort && `思考 ${a.reasoningEffort}`].filter(Boolean).join(' · ')
}

const signed = (v: string | null) => {
  if (v === null) return '-'
  const n = Number(v)
  return `${n > 0 ? '+' : ''}${fmtNumber(v)}`
}

const costText = (s: Standing) => {
  if (!s.llm) return '-'
  if (s.llm.costUsd !== null) return `$${fmtNumber(s.llm.costUsd, 2)}`
  return `输出 ${fmtCompact(s.llm.completionTokens)} token`
}
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold">
          排行榜
        </h2>
        <UBadge
          v-if="sample && (sample.days < 30 || sample.trades < 100)"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
        >
          样本不足
        </UBadge>
      </div>
    </template>
    <div class="overflow-x-auto">
      <UTable
        :data="standings"
        :columns="columns"
        :loading="loading"
        :get-row-id="(row: Standing) => String(row.agent.id)"
        empty="这个赛季还没有参赛的模型"
        class="min-w-[880px] cursor-pointer"
        @select="(_e: Event, row: { original: Standing }) => emit('select', row.original.agent.id)"
      >
        <template #returnPct-header>
          <TermHint :text="GLOSSARY.returnPct">
            收益
          </TermHint>
        </template>
        <template #risk-header>
          <TermHint :text="`${GLOSSARY.drawdown} 平均仓位是每轮持币市值占总资产比例的平均值。`">
            风险
          </TermHint>
        </template>
        <template #pnl-header>
          <TermHint :text="'已实现盈亏是卖出时扣除手续费的盈亏；浮动盈亏是当前持仓的账面盈亏；手续费是累计交易成本。'">
            盈亏
          </TermHint>
        </template>
        <template #trades-header>
          <TermHint :text="`${GLOSSARY.winRate} 盈亏比 = 盈利卖出总额 ÷ 亏损卖出总额，低于 1 说明赚的没有亏的多。`">
            交易
          </TermHint>
        </template>
        <template #llm-header>
          <TermHint :text="GLOSSARY.llmOk">
            LLM
          </TermHint>
        </template>

        <template #rank-cell="{ row }">
          <span class="font-semibold tabular-nums">{{ row.original.returnPct === null ? '-' : row.index + 1 }}</span>
        </template>
        <template #agent-cell="{ row }">
          <div class="flex min-w-44 items-start gap-2">
            <span
              class="mt-1.5 size-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: row.original.agent.color }"
            />
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1">
                <span class="font-medium text-highlighted">{{ row.original.agent.name }}</span>
                <UBadge
                  v-if="row.original.agent.kind === 'baseline'"
                  size="sm"
                  color="neutral"
                  variant="outline"
                >
                  基线
                </UBadge>
                <UBadge
                  v-if="row.original.agent.status === 'paused'"
                  size="sm"
                  color="warning"
                  variant="subtle"
                >
                  已暂停
                </UBadge>
                <UBadge
                  v-if="row.original.leftAt"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                >
                  已退出
                </UBadge>
                <UTooltip
                  v-if="row.original.circuit"
                  :text="`${row.original.circuit.reason}，${fmtDateTime(row.original.circuit.until)} 前只卖不买`"
                >
                  <UBadge
                    size="sm"
                    color="error"
                    variant="subtle"
                    icon="i-lucide-shield-alert"
                  >
                    熔断
                  </UBadge>
                </UTooltip>
              </div>
              <p class="truncate text-xs text-muted">
                {{ agentSubtitle(row.original) }}
              </p>
            </div>
          </div>
        </template>
        <template #returnPct-cell="{ row }">
          <div
            class="text-base font-semibold tabular-nums"
            :class="pnlClass(row.original.returnPct)"
          >
            {{ fmtPct(row.original.returnPct) }}
          </div>
          <div class="text-xs text-muted tabular-nums">
            资产 {{ fmtNumber(row.original.equity) }}
            <template v-if="row.original.excessReturnPct !== null">
              · <span :class="pnlClass(row.original.excessReturnPct)">{{ Number(row.original.excessReturnPct) >= 0 ? '跑赢' : '跑输' }} {{ fmtNumber(Math.abs(Number(row.original.excessReturnPct))) }} 点</span>
            </template>
          </div>
        </template>
        <template #risk-cell="{ row }">
          <div class="tabular-nums">
            回撤 {{ row.original.maxDrawdownPct === null ? '-' : `${fmtNumber(row.original.maxDrawdownPct)}%` }}
          </div>
          <div class="text-xs text-muted">
            {{ row.original.avgExposurePct === null ? '平均仓位 -' : `平均仓位 ${fmtNumber(row.original.avgExposurePct, 0)}%` }}
          </div>
        </template>
        <template #pnl-cell="{ row }">
          <div
            class="tabular-nums"
            :class="pnlClass(row.original.realizedPnl)"
          >
            已实现 {{ signed(row.original.realizedPnl) }}
          </div>
          <div class="text-xs text-muted tabular-nums">
            浮动 {{ signed(row.original.unrealizedPnl) }} · 手续费 {{ fmtNumber(row.original.feesUsdt) }}
          </div>
        </template>
        <template #trades-cell="{ row }">
          <div class="tabular-nums">
            {{ row.original.trades }} 笔
          </div>
          <div class="text-xs text-muted tabular-nums">
            <template v-if="row.original.sells > 0">
              胜率 {{ fmtRatio(row.original.wins, row.original.sells) }} · 盈亏比 {{ row.original.profitFactor === null ? '-' : fmtNumber(row.original.profitFactor) }}
            </template>
            <template v-else>
              还没有卖出
            </template>
          </div>
        </template>
        <template #llm-cell="{ row }">
          <template v-if="row.original.llm">
            <div class="tabular-nums">
              {{ fmtRatio(row.original.llm.ok, answered(row.original.llm)) }}
              <span class="text-xs text-muted">（{{ row.original.llm.ok }}/{{ answered(row.original.llm) }}）</span>
            </div>
            <div class="text-xs text-muted">
              {{ row.original.llm.p95DurationMs === null ? '-' : `p95 ${fmtDuration(row.original.llm.p95DurationMs)}` }} · {{ costText(row.original) }}
            </div>
            <div
              v-if="row.original.llm.retries || row.original.llm.requestFailed"
              class="text-xs text-muted"
            >
              重试 {{ row.original.llm.retries }} · 失败 {{ row.original.llm.requestFailed }}
            </div>
          </template>
          <span
            v-else
            class="text-muted"
          >-</span>
        </template>
      </UTable>
    </div>
  </UCard>
</template>
