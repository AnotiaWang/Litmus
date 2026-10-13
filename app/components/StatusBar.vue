<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import type { StatusResponse } from '#shared/types/api'

const props = defineProps<{
  status: StatusResponse
  /** 正在执行的操作，用于按钮的加载状态 */
  busy: 'pause' | 'resume' | 'run' | null
}>()

const emit = defineEmits<{
  pause: []
  resume: []
  run: []
}>()

// 相对时间（“3 分钟后”）每 15 秒更新一次
const now = ref(Date.now())
useIntervalFn(() => {
  now.value = Date.now()
}, 15_000)
watch(() => props.status, () => {
  now.value = Date.now()
})

// 本地时钟和服务端可能有几秒误差：“上次”不会出现在未来，“下次”过点了也只说“即将开始”
const nextRunText = computed(() => {
  const t = props.status.nextRunAt
  return t && new Date(t).getTime() <= now.value ? '即将开始' : fmtRelative(t, now.value)
})
const lastRunText = computed(() => {
  const t = props.status.lastRunAt
  return t && new Date(t).getTime() >= now.value ? '刚刚' : fmtRelative(t, now.value)
})

// 没暂停时“立即运行一次”可能真的下单，先确认；暂停中只记录信号，直接运行
const confirmOpen = ref(false)
function clickRun() {
  if (props.status.paused) emit('run')
  else confirmOpen.value = true
}
function confirmRun() {
  confirmOpen.value = false
  emit('run')
}

/** 暂停提示：熔断和对账异常是风控在报警，比手动暂停更醒目，并告诉用户下一步做什么 */
const pauseAlert = computed(() => {
  const s = props.status
  if (!s.paused || !s.pauseReason) return null
  if (s.pauseSource === 'daily_loss') {
    return {
      color: 'error' as const,
      icon: 'i-lucide-shield-alert',
      description: `${s.pausedUntil ? `将于 ${fmtDateTime(s.pausedUntil)} 自动恢复。` : ''}熔断期间不会买入，卖出信号（含止损）照常执行。如果想提前恢复，请先确认亏损原因。`
    }
  }
  if (s.pauseSource === 'reconcile') {
    return {
      color: 'error' as const,
      icon: 'i-lucide-scale',
      description: '策略账本和交易所的真实余额对不上，为安全起见已暂停。请先登录交易所 Demo 账户核对持仓和成交记录，确认无误后再点“恢复”。'
    }
  }
  return {
    color: 'warning' as const,
    icon: 'i-lucide-triangle-alert',
    description: '暂停期间每轮只记录信号，不会下单。'
  }
})
</script>

<template>
  <UCard>
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UBadge
          v-if="status.running"
          color="info"
          variant="subtle"
          icon="i-lucide-loader-circle"
          :ui="{ leadingIcon: 'animate-spin' }"
        >
          正在执行本轮决策…
        </UBadge>
        <UBadge
          v-else-if="status.paused"
          color="warning"
          variant="subtle"
          icon="i-lucide-circle-pause"
        >
          已暂停
        </UBadge>
        <UBadge
          v-else
          color="success"
          variant="subtle"
          icon="i-lucide-circle-play"
        >
          自动交易已开启
        </UBadge>
        <UBadge
          color="neutral"
          variant="outline"
        >
          {{ status.mode === 'demo' ? 'Demo Mode' : '测试网' }}
        </UBadge>
        <UBadge
          color="neutral"
          variant="outline"
        >
          {{ status.symbol }}
        </UBadge>
        <UTooltip
          v-if="status.decisionMode === 'llm'"
          :text="`${status.llmCadence}询问一次 LLM，其余轮次只检查止损`"
        >
          <UBadge
            color="primary"
            variant="outline"
            icon="i-lucide-brain"
          >
            LLM 决策 · {{ status.llmCadence }}
          </UBadge>
        </UTooltip>
        <UBadge
          v-else-if="!status.llmEnabled"
          color="neutral"
          variant="outline"
        >
          LLM 复核已关闭
        </UBadge>
        <span class="text-muted">
          每 {{ status.intervalMinutes }} 分钟一轮 ·
          下次{{ status.paused ? (status.pauseSource === 'daily_loss' ? '（只卖不买）' : '（只记录信号）') : '' }}
          <UTooltip :text="fmtDateTime(status.nextRunAt)">
            <span>{{ nextRunText }}</span>
          </UTooltip>
          · 上次
          <UTooltip :text="fmtDateTime(status.lastRunAt)">
            <span>{{ lastRunText }}</span>
          </UTooltip>
        </span>
      </div>
      <div class="flex shrink-0 gap-2">
        <UButton
          v-if="status.paused"
          color="success"
          icon="i-lucide-play"
          :loading="busy === 'resume'"
          @click="$emit('resume')"
        >
          恢复
        </UButton>
        <UButton
          v-else
          color="warning"
          variant="soft"
          icon="i-lucide-pause"
          :loading="busy === 'pause'"
          @click="$emit('pause')"
        >
          暂停
        </UButton>
        <UTooltip
          :text="status.paused
            ? (status.pauseSource === 'daily_loss' ? '熔断中，这一轮不会买入，卖出信号照常执行' : '暂停中，这一轮只记录信号，不会下单')
            : '不等定时，马上执行一轮完整决策'"
        >
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-zap"
            :loading="busy === 'run' || status.running"
            @click="clickRun"
          >
            立即运行一次
          </UButton>
        </UTooltip>
      </div>
    </div>
    <UAlert
      v-if="pauseAlert"
      class="mt-4"
      :color="pauseAlert.color"
      variant="subtle"
      :icon="pauseAlert.icon"
      :title="status.pauseReason!"
      :description="pauseAlert.description"
    />

    <UModal
      v-model:open="confirmOpen"
      title="立即运行一轮决策？"
      :description="status.decisionMode === 'llm'
        ? '当前没有暂停：会马上询问一次 LLM（不受询问频率限制），如果它决定买入或卖出并且风控通过，会真实下单（Demo 虚拟资金）。'
        : '当前没有暂停：如果本轮产生买入或卖出信号，并且 LLM 和风控都通过，会真实下单（Demo 虚拟资金）。'"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="confirmOpen = false"
          >
            取消
          </UButton>
          <UButton
            icon="i-lucide-zap"
            @click="confirmRun"
          >
            确认运行
          </UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
