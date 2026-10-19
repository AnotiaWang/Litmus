<script setup lang="ts">
/** 一个模型在一个赛季里的成绩：资产、收益、回撤和交易、LLM 调用情况。 */
import type { Standing } from '#shared/types/api'

const props = defineProps<{
  standing: Standing
  symbol: string
  capital: string
}>()

const base = computed(() => baseAssetOf(props.symbol))
const llm = computed(() => props.standing.llm)

/** 超额收益用“跑赢 / 跑输 N 个百分点”表达，比带符号的百分比更好懂 */
function excessText(value: string | null): string {
  if (value === null) return '-'
  const n = Number(value)
  if (n === 0) return '持平'
  return `${n > 0 ? '跑赢' : '跑输'} ${fmtNumber(Math.abs(n))} 个百分点`
}
</script>

<template>
  <UCard v-if="standing.equity === null">
    <p class="text-sm text-muted">
      还没有参与过运行。下一轮开始后，账本会以 {{ fmtNumber(capital, 0) }} USDT 起步，这里会显示资产和收益。
    </p>
  </UCard>
  <div
    v-else
    class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
  >
    <UCard>
      <p class="text-sm text-muted">
        资产总值
      </p>
      <p class="mt-1 text-2xl font-semibold tabular-nums">
        {{ fmtNumber(standing.equity) }} <span class="text-sm font-normal text-muted">USDT</span>
      </p>
      <p class="mt-2 text-xs text-muted">
        现金 {{ fmtNumber(standing.usdt) }} USDT · 持有 {{ fmtQty(standing.base) }} {{ base }}（约 {{ fmtNumber(standing.positionValue) }} USDT）
      </p>
      <p
        v-if="standing.entryPrice"
        class="mt-1 text-xs text-muted"
      >
        持仓均价 {{ fmtPrice(standing.entryPrice) }}
        <template v-if="standing.stopPrice">
          · 止损价 {{ fmtPrice(standing.stopPrice) }}
        </template>
      </p>
      <p class="mt-1 text-xs text-muted">
        平均仓位 {{ standing.avgExposurePct === null ? '-' : `${fmtNumber(standing.avgExposurePct, 0)}%` }}
      </p>
    </UCard>
    <UCard>
      <p class="text-sm text-muted">
        <TermHint :text="GLOSSARY.returnPct">
          收益率
        </TermHint>
      </p>
      <p
        class="mt-1 text-2xl font-semibold tabular-nums"
        :class="pnlClass(standing.returnPct)"
      >
        {{ fmtPct(standing.returnPct) }}
      </p>
      <p class="mt-2 text-xs text-muted">
        <TermHint :text="GLOSSARY.benchmark">
          同期一直持有 {{ base }}
        </TermHint>
        {{ fmtPct(standing.benchmarkReturnPct) }} ·
        <span :class="pnlClass(standing.excessReturnPct)">{{ excessText(standing.excessReturnPct) }}</span>
      </p>
      <p class="mt-1 text-xs text-muted">
        自 {{ fmtDateTime(standing.startedAt) }}（{{ fmtPrice(standing.startPrice) }}）
      </p>
      <p class="mt-1 text-xs text-muted">
        期间波动 {{ standing.periodVolPct === null ? '-' : `${fmtNumber(standing.periodVolPct)}%` }}
        · t 值 {{ standing.returnTStat === null ? '-' : fmtNumber(standing.returnTStat, 2) }}
      </p>
    </UCard>
    <UCard>
      <p class="text-sm text-muted">
        <TermHint :text="GLOSSARY.drawdown">
          最大回撤
        </TermHint>
      </p>
      <p class="mt-1 text-2xl font-semibold tabular-nums">
        {{ standing.maxDrawdownPct === null ? '-' : `${fmtNumber(standing.maxDrawdownPct)}%` }}
      </p>
      <p class="mt-2 text-xs text-muted">
        成交 {{ standing.trades }} 笔，其中卖出 {{ standing.sells }} 笔
        <template v-if="standing.sells">
          ·
          <TermHint :text="GLOSSARY.winRate">
            胜率
          </TermHint>
          {{ fmtRatio(standing.wins, standing.sells) }}
        </template>
      </p>
      <p class="mt-1 text-xs text-muted">
        已实现 {{ fmtNumber(standing.realizedPnl) }} · 浮动 {{ standing.unrealizedPnl === null ? '-' : fmtNumber(standing.unrealizedPnl) }} USDT
      </p>
      <p class="mt-1 text-xs text-muted">
        手续费 {{ fmtNumber(standing.feesUsdt) }} USDT · 盈亏比 {{ standing.profitFactor === null ? '-' : fmtNumber(standing.profitFactor) }}
      </p>
    </UCard>
    <UCard v-if="llm">
      <p class="text-sm text-muted">
        <TermHint :text="GLOSSARY.llmOk">
          LLM 成功率
        </TermHint>
      </p>
      <p class="mt-1 text-2xl font-semibold tabular-nums">
        {{ fmtRatio(llm.ok, answered(llm)) }}
        <span class="text-sm font-normal text-muted">{{ llm.ok }} / {{ answered(llm) }} 次</span>
      </p>
      <p class="mt-2 text-xs text-muted">
        输出不合格 {{ llm.invalidOutput }} 次 · 请求失败 {{ llm.requestFailed }} 次 · 重试 {{ llm.retries }} 次
      </p>
      <p class="mt-1 text-xs text-muted">
        平均 {{ fmtDuration(llm.avgDurationMs) }} · p95 {{ fmtDuration(llm.p95DurationMs) }} · 429 {{ llm.http429 }} / 超时 {{ llm.timeouts }}
      </p>
      <p class="mt-1 text-xs text-muted">
        token 输入 {{ fmtCompact(llm.promptTokens) }} / 输出 {{ fmtCompact(llm.completionTokens) }}
        <template v-if="llm.costUsd !== null">
          · 估算成本 ${{ fmtNumber(llm.costUsd, 2) }}
        </template>
      </p>
    </UCard>
    <UCard v-else>
      <p class="text-sm text-muted">
        均线基线
      </p>
      <p class="mt-2 text-xs/relaxed text-muted">
        {{ GLOSSARY.baseline }}
      </p>
    </UCard>
  </div>
</template>
