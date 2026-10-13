<script setup lang="ts">
const { token, authError } = useApi()
const input = ref('')

function submit() {
  authError.value = ''
  token.value = input.value.trim()
}
</script>

<template>
  <UCard class="mx-auto mt-12 max-w-md">
    <template #header>
      <h2 class="font-semibold">
        输入面板口令
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
        :disabled="!input.trim()"
      >
        进入面板
      </UButton>
    </form>
  </UCard>
</template>
