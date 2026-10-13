<script setup lang="ts">
/** 术语旁边的小问号，点开看解释。点击不会冒泡，放在可点击的表格行里也不会触发展开。 */
defineProps<{ text: string }>()
</script>

<template>
  <span class="inline-flex items-center gap-0.5">
    <slot />
    <UPopover :content="{ side: 'top' }">
      <button
        type="button"
        class="inline-flex text-dimmed hover:text-default"
        aria-label="查看解释"
        @click.stop
      >
        <UIcon
          name="i-lucide-circle-help"
          class="size-3.5"
        />
      </button>
      <template #content>
        <p class="max-w-64 p-2 text-xs font-normal whitespace-normal">
          {{ text }}
        </p>
      </template>
    </UPopover>
  </span>
</template>
