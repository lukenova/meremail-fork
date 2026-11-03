<script setup lang="ts">
import ThreadPage from '@/pages/ThreadPage.vue'

defineProps<{
  threadId: number | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <section class="reader-pane">
    <ThreadPage
      v-if="threadId !== null"
      :key="threadId"
      :thread-id="threadId"
      embedded
      @close="emit('close')"
    />
    <div v-else class="reader-empty">
      <div class="reader-empty-icon">✉️</div>
      <div>Select a message to read it</div>
      <div class="reader-empty-hint">
        <kbd>j</kbd> / <kbd>k</kbd> or the arrow keys move between messages.
        <kbd>Ctrl</kbd>+click selects several, <kbd>Delete</kbd> deletes.
      </div>
    </div>
  </section>
</template>

<style scoped>
.reader-pane {
  height: 100vh;
  min-width: 0;
  overflow-y: auto;
}

.reader-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 24px;
  text-align: center;
  color: var(--c-text-999999);
  font-size: 15px;
}

.reader-empty-icon {
  font-size: 40px;
  opacity: 0.5;
}

.reader-empty-hint {
  max-width: 360px;
  font-size: 12px;
  line-height: 1.8;
}

.reader-empty kbd {
  padding: 1px 5px;
  border: 1px solid var(--c-e5e5e5);
  border-radius: 4px;
  font-family: inherit;
}
</style>
