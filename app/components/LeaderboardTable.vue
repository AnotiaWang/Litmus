<script setup lang="ts">
/**
 * 排行榜：按收益率从高到低。点击一行进入模型详情。
 */
import type { TableColumn } from '@nuxt/ui'
import type { Standing } from '#shared/types/api'

defineProps<{
  standings: Standing[]
  loading: boolean
}>()
const emit = defineEmits<{ select: [agentId: number] }>()

const columns: TableColumn<Standing>[] = [
  { id: 'rank', header: '#' },
  { id: 'agent', header: '模型' },
  { accessorKey: 'returnPct', header: '收益率' },
  { accessorKey: 'excessReturnPct', header: '对比一直持有' },
  { accessorKey: 'equity', header: '资产' },
  { accessorKey: 'maxDrawdownPct', header: '最大回撤' },
  { accessorKey: 'trades', header: '成交' },
  { id: 'llm', header: 'LLM' }
]

/** 持币市值占总资产的比例 */
function positionPct(s: Standing): number | null {
  if (!s.equity || !s.positionValue || Number(s.equity) <= 0) return null
  return Number(s.positionValue) / Number(s.equity) * 100
}

function agentSubtitle(s: Standing): string {
  const a = s.agent
  if (a.kind === 'baseline') return '均线规则，不调用 LLM'
  return [a.provider, a.model, a.reasoningEffort && `思考 ${a.reasoningEffort}`].filter(Boolean).join(' · ')
}
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <h2 class="font-semibold">
        排行榜
      </h2>
    </template>
    <UTable
      :data="standings"
      :columns="columns"
      :loading="loading"
      :get-row-id="(row: Standing) => String(row.agent.id)"
      empty="这个赛季还没有参赛的模型"
      class="cursor-pointer"
      @select="(_e: Event, row: { original: Standing }) => emit('select', row.original.agent.id)"
    >
      <template #returnPct-header>
        <TermHint :text="GLOSSARY.returnPct">
          收益率
        </TermHint>
      </template>
      <template #excessReturnPct-header>
        <TermHint :text="GLOSSARY.excess">
          对比一直持有
        </TermHint>
      </template>
      <template #maxDrawdownPct-header>
        <TermHint :text="GLOSSARY.drawdown">
          最大回撤
        </TermHint>
      </template>
      <template #llm-header>
        <TermHint :text="GLOSSARY.llmOk">
          LLM 成功率
        </TermHint>
      </template>

      <template #rank-cell="{ row }">
        <span class="font-semibold tabular-nums">{{ row.original.returnPct === null ? '-' : row.index + 1 }}</span>
      </template>
      <template #agent-cell="{ row }">
        <div class="flex min-w-48 items-start gap-2">
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
        <span
          class="text-base font-semibold tabular-nums"
          :class="pnlClass(row.original.returnPct)"
        >{{ fmtPct(row.original.returnPct) }}</span>
      </template>
      <template #excessReturnPct-cell="{ row }">
        <span
          v-if="row.original.excessReturnPct !== null"
          class="tabular-nums"
          :class="pnlClass(row.original.excessReturnPct)"
        >{{ Number(row.original.excessReturnPct) >= 0 ? '跑赢' : '跑输' }} {{ fmtNumber(Math.abs(Number(row.original.excessReturnPct))) }} 点</span>
        <span
          v-else
          class="text-muted"
        >-</span>
      </template>
      <template #equity-cell="{ row }">
        <div class="tabular-nums">
          {{ fmtNumber(row.original.equity) }}
        </div>
        <div
          v-if="positionPct(row.original) !== null"
          class="text-xs text-muted"
        >
          {{ positionPct(row.original)! < 0.5 ? '空仓' : `持仓 ${Math.round(positionPct(row.original)!)}%` }}
        </div>
      </template>
      <template #maxDrawdownPct-cell="{ row }">
        <span class="tabular-nums">{{ row.original.maxDrawdownPct === null ? '-' : `${fmtNumber(row.original.maxDrawdownPct)}%` }}</span>
      </template>
      <template #trades-cell="{ row }">
        <div class="tabular-nums">
          {{ row.original.trades }} 笔
        </div>
        <UTooltip
          v-if="row.original.sells > 0"
          :text="`卖出 ${row.original.sells} 笔，其中 ${row.original.wins} 笔盈利（扣除手续费）`"
        >
          <div class="text-xs text-muted">
            胜率 {{ fmtRatio(row.original.wins, row.original.sells) }}
          </div>
        </UTooltip>
      </template>
      <template #llm-cell="{ row }">
        <template v-if="row.original.llm">
          <div class="tabular-nums">
            {{ fmtRatio(row.original.llm.ok, answered(row.original.llm)) }}
            <span class="text-xs text-muted">（{{ row.original.llm.ok }}/{{ answered(row.original.llm) }}）</span>
          </div>
          <div
            v-if="row.original.llm.requestFailed"
            class="text-xs text-muted"
          >
            请求失败 {{ row.original.llm.requestFailed }} 次
          </div>
          <div
            v-if="row.original.llm.avgDurationMs !== null"
            class="text-xs text-muted"
          >
            平均 {{ fmtDuration(row.original.llm.avgDurationMs) }}
          </div>
        </template>
        <span
          v-else
          class="text-muted"
        >-</span>
      </template>
    </UTable>
  </UCard>
</template>
