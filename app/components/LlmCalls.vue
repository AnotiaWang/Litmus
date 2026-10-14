<script setup lang="ts">
/** LLM 请求列表：概览（模型、耗时、token），每次请求的状态、思考过程和输出。决策详情和测试模型共用 */
import type { LlmCall } from '#shared/types/api'

const props = defineProps<{ calls: LlmCall[] }>()

const summary = computed(() => {
  const list = props.calls
  if (!list.length) return null
  const sum = (pick: (c: LlmCall) => number | null | undefined) => {
    const values = list.map(pick).filter((v): v is number => typeof v === 'number')
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  const last = list.at(-1)!
  return {
    model: last.responseModel && last.responseModel !== last.model ? `${last.model}（实际 ${last.responseModel}）` : last.model,
    effort: last.reasoningEffort ?? '默认',
    durationMs: sum(c => c.durationMs)!,
    promptTokens: sum(c => c.usage?.promptTokens),
    completionTokens: sum(c => c.usage?.completionTokens),
    reasoningTokens: sum(c => c.usage?.reasoningTokens)
  }
})

/** 输出是合法 JSON 时缩进显示，更好读 */
function prettyContent(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- 概览 -->
    <section
      v-if="summary"
      class="grid grid-cols-2 gap-3 rounded-md bg-elevated p-3 sm:grid-cols-4"
    >
      <div class="col-span-2">
        <p class="text-xs text-muted">
          模型
        </p>
        <p class="break-all">
          {{ summary.model }}
        </p>
      </div>
      <div>
        <p class="text-xs text-muted">
          思考强度
        </p>
        <p>{{ summary.effort }}</p>
      </div>
      <div>
        <p class="text-xs text-muted">
          请求次数 / 总耗时
        </p>
        <p>{{ calls.length }} 次 · {{ fmtDuration(summary.durationMs) }}</p>
      </div>
      <div class="col-span-2 sm:col-span-4">
        <p class="text-xs text-muted">
          Token 用量
        </p>
        <p>
          输入 {{ fmtTokens(summary.promptTokens) }} · 输出 {{ fmtTokens(summary.completionTokens) }}
          <template v-if="summary.reasoningTokens !== null">
            （其中思考 {{ fmtTokens(summary.reasoningTokens) }}）
          </template>
        </p>
      </div>
    </section>

    <!-- 每次请求 -->
    <section
      v-for="(call, i) in calls"
      :key="i"
      class="space-y-3"
    >
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="font-semibold">
          第 {{ i + 1 }} 次请求
        </h3>
        <UBadge
          v-if="call.httpStatus !== null"
          :color="call.httpStatus === 200 ? 'neutral' : 'error'"
          variant="outline"
          size="sm"
        >
          HTTP {{ call.httpStatus }}
        </UBadge>
        <UBadge
          color="neutral"
          variant="outline"
          size="sm"
        >
          {{ fmtDuration(call.durationMs) }}
        </UBadge>
        <UBadge
          v-if="call.finishReason && call.finishReason !== 'stop'"
          color="warning"
          variant="outline"
          size="sm"
        >
          结束原因 {{ call.finishReason }}
        </UBadge>
        <span class="text-xs text-muted">{{ fmtDateTime(call.startedAt) }}</span>
      </div>

      <UAlert
        v-if="call.error"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="call.error"
      />

      <details
        v-if="call.reasoning"
        open
        class="group"
      >
        <summary class="cursor-pointer font-medium select-none">
          思考过程
          <span
            v-if="call.usage?.reasoningTokens"
            class="font-normal text-muted"
          >（{{ fmtTokens(call.usage.reasoningTokens) }} token）</span>
        </summary>
        <pre class="mt-2 max-h-96 overflow-auto rounded-md bg-elevated p-3 font-sans text-xs/relaxed whitespace-pre-wrap text-muted">{{ call.reasoning }}</pre>
      </details>
      <p
        v-else-if="call.httpStatus === 200"
        class="text-xs text-muted"
      >
        这次请求没有返回思考过程（有的服务或模型不提供，比如 OpenAI 官方接口只给思考用量）。
        <template v-if="call.usage?.reasoningTokens">
          思考用了 {{ fmtTokens(call.usage.reasoningTokens) }} token。
        </template>
      </p>

      <div v-if="call.content !== null">
        <p class="font-medium">
          输出
        </p>
        <pre class="mt-2 max-h-64 overflow-auto rounded-md bg-elevated p-3 text-xs whitespace-pre-wrap">{{ prettyContent(call.content) }}</pre>
      </div>
    </section>
  </div>
</template>
