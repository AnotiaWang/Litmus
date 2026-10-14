<script setup lang="ts">
/** 确认框：危险或不可撤销的操作前先问一下 */
withDefaults(defineProps<{
  title: string
  description?: string
  confirmLabel?: string
  color?: 'primary' | 'error' | 'warning'
  icon?: string
  loading?: boolean
}>(), {
  description: undefined,
  confirmLabel: '确认',
  color: 'primary',
  icon: undefined,
  loading: false
})
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
  >
    <template
      v-if="$slots.default"
      #body
    >
      <slot />
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
          :color="color"
          :icon="icon"
          :loading="loading"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
