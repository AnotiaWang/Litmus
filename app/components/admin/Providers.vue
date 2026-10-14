<script setup lang="ts">
/** Provider 列表：OpenAI 兼容接口的地址和 Key。Key 只显示打码后的样子；下面还有模型时不能删除。 */
import type { ProviderView } from '#shared/types/api'

defineProps<{ providers: ProviderView[] }>()
const emit = defineEmits<{ changed: [] }>()

const { request } = useApi()
const toast = useToast()

const formOpen = ref(false)
const editing = ref<ProviderView | null>(null)
const deleting = ref<ProviderView | null>(null)
const deleteBusy = ref(false)

function openCreate() {
  editing.value = null
  formOpen.value = true
}
function openEdit(p: ProviderView) {
  editing.value = p
  formOpen.value = true
}

async function remove() {
  if (!deleting.value) return
  deleteBusy.value = true
  try {
    await request(`/api/admin/providers/${deleting.value.id}`, { method: 'DELETE' })
    toast.add({ title: `已删除 ${deleting.value.name}`, color: 'success' })
    deleting.value = null
    emit('changed')
  } catch (e) {
    toast.add({ title: '删除失败', description: errorMessage(e), color: 'error' })
  } finally {
    deleteBusy.value = false
  }
}
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold">
            Provider
          </h2>
          <p class="text-xs text-muted">
            任何 OpenAI 兼容的 /chat/completions 接口：OpenAI、OpenRouter、DeepSeek、各家云服务或自建的代理。
          </p>
        </div>
        <UButton
          icon="i-lucide-plus"
          @click="openCreate"
        >
          添加
        </UButton>
      </div>
    </template>

    <p
      v-if="providers.length === 0"
      class="p-6 text-center text-sm text-muted"
    >
      还没有 Provider。添加一个之后就能在“模型”里添加要测试的模型。
    </p>
    <ul
      v-else
      class="divide-y divide-default"
    >
      <li
        v-for="p in providers"
        :key="p.id"
        class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="min-w-0">
          <p class="font-medium">
            {{ p.name }}
            <span class="ml-1 text-xs font-normal text-muted">{{ p.agentCount }} 个模型</span>
          </p>
          <p class="truncate text-sm text-muted">
            {{ p.baseUrl }} · Key {{ p.apiKeyMasked }}
          </p>
        </div>
        <div class="flex shrink-0 gap-1">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-pencil"
            @click="openEdit(p)"
          >
            修改
          </UButton>
          <UTooltip
            :text="p.agentCount ? '下面还有模型（含已归档），不能删除' : '删除'"
          >
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="p.agentCount > 0"
              aria-label="删除"
              @click="deleting = p"
            />
          </UTooltip>
        </div>
      </li>
    </ul>

    <AdminProviderForm
      v-model:open="formOpen"
      :provider="editing"
      @saved="emit('changed')"
    />
    <ConfirmModal
      :open="deleting !== null"
      :title="`删除 Provider「${deleting?.name}」？`"
      description="删除后不能恢复。"
      confirm-label="删除"
      color="error"
      :loading="deleteBusy"
      @update:open="(v: boolean) => { if (!v) deleting = null }"
      @confirm="remove"
    />
  </UCard>
</template>
