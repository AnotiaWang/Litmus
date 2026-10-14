<script setup lang="ts">
/**
 * LLM 调用详情（侧边抽屉）：模型、耗时、token 用量，每次请求的思考过程和输出，以及发给它的提示词。
 * 打开时才按需加载这一条决策的详情。
 */
import type { AgentPublic, Decision } from '#shared/types/api'

const props = defineProps<{
  decisionId: string | null
  /** 用来在标题里显示模型名 */
  agents?: Map<number, AgentPublic>
}>()
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
</script>

<template>
  <USlideover
    v-model:open="open"
    title="LLM 调用详情"
    :description="decision ? [agents?.get(decision.agentId)?.name, fmtDateTime(decision.createdAt)].filter(Boolean).join(' · ') : undefined"
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
          v-if="decision.llmStatus"
          class="space-y-1"
        >
          <p v-if="decision.llmStatus === 'ok' && decision.llmDecision">
            <span :class="ACTIONS[decision.llmDecision].className">
              {{ actionText(decision.llmDecision, decision.llmSizePct) }}
            </span>
            <span class="text-muted"> · 置信度 {{ decision.llmConfidence }}</span>
          </p>
          <UBadge
            v-else
            :color="LLM_STATUS[decision.llmStatus].color"
            variant="subtle"
          >
            {{ LLM_STATUS[decision.llmStatus].label }}，程序代为观望
          </UBadge>
          <p v-if="decision.llmReason">
            {{ decision.llmReason }}
          </p>
        </section>

        <LlmCalls :calls="calls" />

        <p
          v-if="!decision.llmCalls"
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
