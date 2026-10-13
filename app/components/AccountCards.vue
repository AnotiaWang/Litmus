<script setup lang="ts">
import type { AccountResponse } from '#shared/types/api'

defineProps<{ account: AccountResponse }>()

const terms = glossary()

/** 超额收益用“跑赢 / 跑输 N 个百分点”表达，比带符号的百分比更好懂 */
function excessText(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  if (n === 0) return '持平'
  return `${n > 0 ? '跑赢' : '跑输'} ${fmtNumber(Math.abs(n))} 个百分点`
}
</script>

<template>
  <div v-if="!account.ready">
    <UCard>
      <p class="text-sm text-muted">
        策略账本还没有开始（刚部署，或刚修改了预算）。下一轮运行后，账本会以 {{ account.budget }} USDT 起步，这里会显示资产和收益。
      </p>
    </UCard>
  </div>
  <div
    v-else
    class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
  >
    <UCard>
      <p class="text-sm text-muted">
        账本资产总值
      </p>
      <p class="mt-1 text-2xl font-semibold">
        {{ fmtNumber(account.total) }} <span class="text-sm font-normal text-muted">USDT</span>
      </p>
      <p class="mt-2 text-xs text-muted">
        现金 {{ fmtNumber(account.usdt) }} USDT · 持有 {{ fmtQty(account.base) }} {{ account.baseAsset }}（约 {{ fmtNumber(account.positionValue) }} USDT）
      </p>
      <p
        v-if="account.entryPrice"
        class="mt-1 text-xs text-muted"
      >
        持仓均价 {{ fmtPrice(account.entryPrice) }}
        <template v-if="account.stopPrice">
          · 止损价 {{ fmtPrice(account.stopPrice) }}（现价跌破会自动卖出）
        </template>
        <template v-else>
          · 止损未开启
        </template>
      </p>
    </UCard>
    <UCard>
      <p class="text-sm text-muted">
        策略收益率
      </p>
      <p
        class="mt-1 text-2xl font-semibold"
        :class="pnlClass(account.returnPct)"
      >
        {{ fmtPct(account.returnPct) }}
      </p>
      <p class="mt-2 text-xs text-muted">
        起始资金 {{ fmtNumber(account.budget) }} USDT · 自 {{ fmtDateTime(account.startedAt) }}
      </p>
    </UCard>
    <UCard>
      <p class="text-sm text-muted">
        <TermHint :text="terms.benchmark">
          同期“一直持有 {{ account.baseAsset }}”收益率
        </TermHint>
      </p>
      <p
        class="mt-1 text-2xl font-semibold"
        :class="pnlClass(account.benchmarkReturnPct)"
      >
        {{ fmtPct(account.benchmarkReturnPct) }}
      </p>
      <p class="mt-2 text-xs text-muted">
        起始价 {{ fmtPrice(account.initialPrice) }} → 当前 {{ fmtPrice(account.price) }}（{{ fmtTime(account.asOf) }}）
      </p>
    </UCard>
    <UCard>
      <p class="text-sm text-muted">
        <TermHint :text="terms.excess">
          超额收益
        </TermHint>
      </p>
      <p
        class="mt-1 text-2xl font-semibold"
        :class="pnlClass(account.excessReturnPct)"
      >
        {{ excessText(account.excessReturnPct) }}
      </p>
      <p class="mt-2 text-xs text-muted">
        策略 {{ fmtPct(account.returnPct) }} 对比一直持有 {{ fmtPct(account.benchmarkReturnPct) }}
      </p>
    </UCard>
  </div>
</template>
