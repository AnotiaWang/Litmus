<script setup lang="ts">
/**
 * 外框：顶栏 + 页面。先查一次访问权限：
 * - 开启了公开浏览，或带着正确的口令：直接显示页面
 * - 关闭了公开浏览且没有口令：显示口令输入框（管理页自己处理登录）
 */
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'zh-CN'
  }
})

useSeoMeta({
  title: 'Litmus · LLM 交易决策基准'
})

const route = useRoute()
const { session, canRead, loadSession } = useApi()
const loadError = ref('')
const loading = ref(false)

async function init() {
  loading.value = true
  try {
    await loadSession()
    loadError.value = ''
  } catch (e) {
    loadError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
init()
</script>

<template>
  <UApp>
    <UMain>
      <UContainer class="space-y-6 py-6">
        <AppHeader />

        <UAlert
          v-if="loadError"
          color="error"
          variant="subtle"
          icon="i-lucide-wifi-off"
          title="连接服务失败"
          :description="loadError"
          :actions="[{ label: '重试', color: 'error', variant: 'outline', loading, onClick: init }]"
        />
        <template v-else-if="session">
          <NuxtPage v-if="canRead || route.path === '/admin'" />
          <TokenForm
            v-else
            description="这个站点没有开放公开浏览，输入口令后才能查看。"
          />
        </template>
        <USkeleton
          v-else
          class="h-96 w-full"
        />
      </UContainer>
    </UMain>
  </UApp>
</template>
