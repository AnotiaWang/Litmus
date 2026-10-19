<script setup lang="ts">
/** 模型健康：成功率、重试、429/超时、耗时和估算成本，帮助发现“看起来成功、其实很慢/很贵”的模型 */
import type { TableColumn } from '@nuxt/ui'
import type { AdminHealthModel, AdminHealthResponse } from '#shared/types/api'

const { request } = useApi()
const data = ref<AdminHealthResponse | null>(null)
const error = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    data.value = await request<AdminHealthResponse>('/api/admin/health')
    error.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
load()
usePolling(load, 10_000)

const columns: TableColumn<AdminHealthModel>[] = [
  { id: 'agent', header: '模型' },
  { id: 'success', header: '成功率' },
  { id: 'retries', header: '重试 / 429 / 超时' },
  { id: 'latency', header: '耗时' },
  { id: 'cost', header: 'Token / 成本' },
  { id: 'lastError', header: '最近错误' }
]

const answered = (m: AdminHealthModel) => m.asked - m.requestFailed
const cost = (m: AdminHealthModel) => m.costUsd === null ? '-' : `$${fmtNumber(m.costUsd, 2)}`
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold">
            模型健康
          </h2>
          <p class="text-xs text-muted">
            成功率只算模型作答；重试、429、超时是服务稳定性；耗时和成本按当前赛季累计。升级前的旧决策没有重试明细，统计从升级后开始。
          </p>
        </div>
        <UBadge
          v-if="data"
          color="neutral"
          variant="outline"
        >
          {{ data.models.length }} 个 LLM
        </UBadge>
      </div>
    </template>

    <UAlert
      v-if="error"
      class="m-4 w-auto"
      color="error"
      variant="subtle"
      icon="i-lucide-wifi-off"
      :title="`加载健康数据失败：${error}`"
      :actions="[{ label: '重试', color: 'error', variant: 'outline', onClick: load }]"
    />

    <div
      v-else
      class="overflow-x-auto"
    >
      <UTable
        :data="data?.models ?? []"
        :columns="columns"
        :loading="loading && !data"
        empty="这个赛季还没有 LLM 模型"
        class="min-w-[900px]"
      >
        <template #agent-cell="{ row }">
          <div class="flex items-center gap-2">
            <span
              class="size-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: row.original.color }"
            />
            <span class="font-medium">{{ row.original.name }}</span>
            <UBadge
              v-if="row.original.status === 'paused'"
              size="sm"
              color="warning"
              variant="subtle"
            >
              已暂停
            </UBadge>
            <UBadge
              v-if="row.original.status === 'archived'"
              size="sm"
              color="neutral"
              variant="subtle"
            >
              已归档
            </UBadge>
          </div>
          <p
            v-if="row.original.lastAskedAt"
            class="text-xs text-muted"
          >
            最近询问 {{ fmtDateTime(row.original.lastAskedAt) }}
          </p>
        </template>
        <template #success-cell="{ row }">
          <div class="tabular-nums">
            {{ fmtRatio(row.original.ok, answered(row.original)) }}
            <span class="text-xs text-muted">（{{ row.original.ok }}/{{ answered(row.original) }}）</span>
          </div>
          <div
            v-if="row.original.requestFailed || row.original.invalidOutput"
            class="text-xs text-muted"
          >
            失败 {{ row.original.requestFailed }} · 不合格 {{ row.original.invalidOutput }}
          </div>
        </template>
        <template #retries-cell="{ row }">
          <div class="tabular-nums">
            重试 {{ row.original.retries }}
          </div>
          <div class="text-xs text-muted tabular-nums">
            429 {{ row.original.http429 }} · 超时 {{ row.original.timeouts }}
          </div>
        </template>
        <template #latency-cell="{ row }">
          <div class="tabular-nums">
            p50 {{ fmtDuration(row.original.p50DurationMs) }}
          </div>
          <div class="text-xs text-muted tabular-nums">
            p95 {{ fmtDuration(row.original.p95DurationMs) }} · 最长 {{ fmtDuration(row.original.maxDurationMs) }}
          </div>
        </template>
        <template #cost-cell="{ row }">
          <div class="tabular-nums">
            {{ fmtCompact(row.original.promptTokens) }} / {{ fmtCompact(row.original.completionTokens) }}
          </div>
          <div class="text-xs text-muted tabular-nums">
            {{ cost(row.original) }}
          </div>
        </template>
        <template #lastError-cell="{ row }">
          <template v-if="row.original.lastError">
            <p class="max-w-72 truncate text-xs text-error">
              {{ row.original.lastError }}
            </p>
            <p class="text-xs text-muted">
              {{ fmtDateTime(row.original.lastErrorAt) }}
            </p>
          </template>
          <span
            v-else
            class="text-xs text-muted"
          >-</span>
        </template>
      </UTable>
    </div>
  </UCard>
</template>
