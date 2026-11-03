<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SyncFailures from '@/components/SyncFailures.vue'
import BottomNav from '@/components/BottomNav.vue'
import FolderSidebar from '@/components/FolderSidebar.vue'
import PaneResizer from '@/components/PaneResizer.vue'
import { usePaneWidth, SIDEBAR_WIDTH } from '@/composables/usePaneWidth'
import { useWideLayout } from '@/composables/useWideLayout'
import { useOffline, setNavigationHandler, initializeNotifications } from '@/composables/useOffline'
import { onAuthRequired } from '@/local/sync'
import { resetAuthState } from '@/auth'

const route = useRoute()
const router = useRouter()

const wide = useWideLayout()

// Wide windows keep the folder sidebar on the left of every page
const showSidebar = computed(() => wide.value && route.name !== undefined && !route.meta.public)
const sidebarWidth = usePaneWidth('meremail.sidebarWidth', SIDEBAR_WIDTH, 170, 420)

const showBottomNav = computed(() => {
  if (showSidebar.value) return false
  // Show on main pages and any folder route
  if (['/', '/reply-later', '/set-aside', '/rules', '/folders', '/contacts', '/attachments'].includes(route.path)) return true
  if (route.path.startsWith('/folder/')) return true
  return false
})

onMounted(async () => {
  // Set up navigation handler for service worker notifications
  setNavigationHandler((url: string) => {
    router.push(url)
  })

  // Listen for service worker messages (sync requests, notification clicks)
  useOffline()

  // If the session has expired, sync can't continue until the user logs in again
  onAuthRequired(() => {
    resetAuthState()
    if (route.name !== 'login') {
      router.push({ name: 'login', query: { redirect: route.fullPath } })
    }
  })

  // Initialize notifications (request permission and register periodic sync)
  try {
    await initializeNotifications()
  } catch (e) {
    console.error('Failed to initialize notifications:', e)
  }
})
</script>

<template>
  <div
    class="app-wrapper"
    :class="{ shell: showSidebar }"
    :style="showSidebar ? { gridTemplateColumns: `${sidebarWidth}px 1px minmax(0, 1fr)` } : undefined"
  >
    <FolderSidebar v-if="showSidebar" class="shell-sidebar" />
    <PaneResizer v-if="showSidebar" v-model="sidebarWidth" class="shell-resizer" :min="170" :max="420" :default-width="SIDEBAR_WIDTH" />
    <div v-if="showSidebar" class="shell-main"><RouterView /></div>
    <RouterView v-else />
    <SyncFailures />
    <BottomNav v-if="showBottomNav" />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--c-text-1a1a1a);
  background: var(--c-ffffff);
  -webkit-font-smoothing: antialiased;
}

.app-wrapper {
  position: relative;
}

/* Folders | page. The sidebar stays put while the page scrolls the window,
   or, for the mail pages, scrolls its own list and reading panes. */
.app-wrapper.shell {
  display: grid;
  align-items: start;
}

.shell-sidebar,
.shell-resizer {
  position: sticky;
  top: 0;
}

.shell-main {
  min-width: 0;
}
</style>
