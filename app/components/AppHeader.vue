<script setup lang="ts">
const route = useRoute()
const { isAdmin, logout } = useApi()

const links = computed(() => [
  { label: '排行榜', icon: 'i-lucide-trophy', to: '/', active: route.path === '/' || route.path.startsWith('/agents/') },
  { label: '方法', icon: 'i-lucide-book-open', to: '/methodology', active: route.path === '/methodology' },
  { label: '管理', icon: 'i-lucide-settings', to: '/admin', active: route.path === '/admin' }
])
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-3">
    <NuxtLink
      to="/"
      class="flex flex-wrap items-baseline gap-x-3 gap-y-1"
    >
      <span class="text-xl font-bold sm:text-2xl">Litmus</span>
      <span class="text-sm text-muted">LLM 交易决策基准 · 模拟撮合，虚拟资金</span>
    </NuxtLink>
    <nav class="flex items-center gap-1">
      <UButton
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :icon="link.icon"
        :color="link.active ? 'primary' : 'neutral'"
        :variant="link.active ? 'soft' : 'ghost'"
      >
        {{ link.label }}
      </UButton>
      <UTooltip
        v-if="isAdmin"
        text="退出管理"
      >
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-log-out"
          aria-label="退出管理"
          @click="logout"
        />
      </UTooltip>
      <UColorModeButton />
    </nav>
  </header>
</template>
