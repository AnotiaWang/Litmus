<script setup lang="ts">
withDefaults(defineProps<{ title?: string, description?: string }>(), {
  title: '输入管理口令',
  description: undefined
})

const { authError, login } = useApi()
const input = ref('')
const submitting = ref(false)

async function submit() {
  submitting.value = true
  try {
    await login(input.value.trim())
  } catch (e) {
    authError.value = `验证失败：${errorMessage(e)}`
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UCard class="mx-auto mt-12 max-w-md">
    <template #header>
      <h2 class="font-semibold">
        {{ title }}
      </h2>
    </template>
    <form
      class="space-y-4"
      @submit.prevent="submit"
    >
      <UAlert
        v-if="authError"
        color="error"
        variant="subtle"
        :title="authError"
        icon="i-lucide-lock"
      />
      <p
        v-if="description"
        class="text-sm"
      >
        {{ description }}
      </p>
      <p class="text-sm text-muted">
        口令就是 .env 里的 ADMIN_TOKEN，只保存在当前浏览器。
      </p>
      <UInput
        v-model="input"
        type="password"
        placeholder="ADMIN_TOKEN"
        autocomplete="current-password"
        class="w-full"
        autofocus
      />
      <UButton
        type="submit"
        block
        :loading="submitting"
        :disabled="!input.trim()"
      >
        进入
      </UButton>
    </form>
  </UCard>
</template>
