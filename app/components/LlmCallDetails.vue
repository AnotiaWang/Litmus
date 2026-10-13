<script setup lang="ts">
/**
 * LLM 调用详情（侧边抽屉）：模型、耗时、token 用量，每次请求的思考过程和输出，以及发给它的提示词。
 * 打开时才按需加载这一条决策的详情。
 */
import type { Decision, LlmCall } from '#shared/types/api'

const props = defineProps<{ decisionId: string | null }>()
const open = defineModel<boolean>('open', { required: true })

const { request } = useApi()

const decision = ref<Decision | null>(null)
const loading = ref(false)
const error = ref('')

watch(() => [open.value, props.decisionId] as const, async ([isOpen, id]) => {
  if (!isOpen || !id || decision.value?.id === id) return
  decision.value = null
  error.value = ''
  loading.value = true
  try {
    decision.value = await request<Decision>(`/api/decisions/${id}`)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}, { immediate: true })

const calls = computed(() => decision.value?.llmCalls ?? [])

const summary = computed(() => {
  const list = calls.value
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

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

const fmtTokens = (n: number | null | undefined) => typeof n === 'number' ? n.toLocaleString('zh-CN') : '-'

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
  <USlideover
    v-model:open="open"
    title="LLM 调用详情"
    :description="decision ? `${fmtDateTime(decision.createdAt)} · ${decision.symbol}` : undefined"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <div
        v-if="loading"
        class="space-y-3"
      >
        <USkeleton class="h-20 w-full" />
        <USkeleton class="h-64 w-full" />
      </div>

      <UAlert
        v-else-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="加载失败"
        :description="error"
      />

      <div
        v-else-if="decision"
        class="space-y-6 text-sm"
      >
        <!-- 结论 -->
        <section
          v-if="decision.llmDecision"
          class="space-y-1"
        >
          <p>
            <span :class="LLM_DECISIONS[decision.llmDecision].className">
              {{ llmDecisionText(decision) }}
            </span>
            <span class="text-muted"> · 置信度 {{ decision.llmConfidence }}</span>
          </p>
          <p>{{ decision.llmReason }}</p>
        </section>

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

        <!-- 升级前的旧记录只有原始输出 -->
        <section
          v-if="!decision.llmCalls && decision.llmRaw"
          class="space-y-2"
        >
          <p class="text-xs text-muted">
            这条是升级前的记录，只保存了 LLM 的原始输出，没有思考过程和用量。
          </p>
          <pre class="max-h-96 overflow-auto rounded-md bg-elevated p-3 text-xs whitespace-pre-wrap">{{ decision.llmRaw }}</pre>
        </section>

        <p
          v-if="!decision.llmCalls && !decision.llmRaw"
          class="text-muted"
        >
          这一轮没有调用 LLM。
        </p>

        <!-- 提示词 -->
        <section
          v-if="decision.llmPrompt"
          class="space-y-2"
        >
          <h3 class="font-semibold">
            提示词
          </h3>
          <details>
            <summary class="cursor-pointer select-none">
              系统提示词
            </summary>
            <pre class="mt-2 max-h-96 overflow-auto rounded-md bg-elevated p-3 text-xs whitespace-pre-wrap">{{ decision.llmPrompt.system }}</pre>
          </details>
          <details>
            <summary class="cursor-pointer select-none">
              用户提示词（行情、账本和最近决策）
            </summary>
            <pre class="mt-2 max-h-96 overflow-auto rounded-md bg-elevated p-3 text-xs whitespace-pre-wrap">{{ decision.llmPrompt.user }}</pre>
          </details>
        </section>
      </div>
    </template>
  </USlideover>
</template>
