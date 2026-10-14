<script setup lang="ts">
/** 添加 / 修改 Provider。修改时 Key 留空表示不改。 */
import { providerInputSchema, providerUpdateSchema } from '#shared/agents'
import type { ProviderView } from '#shared/types/api'

const props = defineProps<{ provider: ProviderView | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const { request } = useApi()
const toast = useToast()

const state = reactive({ name: '', baseUrl: '', apiKey: '' })
const saving = ref(false)
const schema = computed(() => props.provider ? providerUpdateSchema : providerInputSchema)

watch(open, (v) => {
  if (!v) return
  state.name = props.provider?.name ?? ''
  state.baseUrl = props.provider?.baseUrl ?? 'https://'
  state.apiKey = ''
})

async function save() {
  saving.value = true
  try {
    const body = schema.value.parse(state)
    if (props.provider) {
      await request(`/api/admin/providers/${props.provider.id}`, { method: 'PUT', body })
    } else {
      await request('/api/admin/providers', { method: 'POST', body })
    }
    toast.add({ title: props.provider ? '已保存' : `已添加 ${body.name}`, color: 'success' })
    open.value = false
    emit('saved')
  } catch (e) {
    toast.add({ title: '保存失败', description: errorMessage(e), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="provider ? `修改 ${provider.name}` : '添加 Provider'"
  >
    <template #body>
      <UForm
        id="provider-form"
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="save"
      >
        <UFormField
          name="name"
          label="名称"
          description="页面上显示的名字，如 OpenRouter、DeepSeek。"
          required
        >
          <UInput
            v-model="state.name"
            class="w-full"
          />
        </UFormField>
        <UFormField
          name="baseUrl"
          label="接口地址"
          description="请求会发到 {地址}/chat/completions，通常以 /v1 结尾。"
          required
        >
          <UInput
            v-model="state.baseUrl"
            placeholder="https://api.openai.com/v1"
            class="w-full"
          />
        </UFormField>
        <UFormField
          name="apiKey"
          label="API Key"
          :description="provider ? `当前 ${provider.apiKeyMasked}，留空表示不改。` : '只保存在服务器上，页面上只显示打码后的样子。'"
          :required="!provider"
        >
          <UInput
            v-model="state.apiKey"
            type="password"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          取消
        </UButton>
        <UButton
          type="submit"
          form="provider-form"
          :loading="saving"
        >
          保存
        </UButton>
      </div>
    </template>
  </UModal>
</template>
