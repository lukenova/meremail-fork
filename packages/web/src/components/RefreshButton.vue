<script setup lang="ts">
import { isRefreshing, refreshNow } from '@/local/sync'
</script>

<template>
  <button
    class="refresh-btn"
    :class="{ spinning: isRefreshing }"
    :disabled="isRefreshing"
    title="Check for new mail now"
    aria-label="Check for new mail now"
    @click="refreshNow"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"></polyline>
      <polyline points="1 20 1 14 7 14"></polyline>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
    <span>{{ isRefreshing ? 'Checking…' : 'Refresh' }}</span>
  </button>
</template>

<style scoped>
.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--c-e5e5e5);
  border-radius: 6px;
  background: var(--c-ffffff);
  color: var(--c-text-666666);
  font-size: 13px;
  cursor: pointer;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--c-f5f5f5);
  color: var(--c-text-333333);
}

.refresh-btn:disabled {
  cursor: default;
  opacity: 0.8;
}

.spinning svg {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
