<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import SyncStatus from '@/components/SyncStatus.vue'
import { useLiveQuery } from '@/local/live'
import { getNavigation, type Navigation, type FolderNavItem } from '@/local/queries'
import { uuid } from '@/local/uuid'

const route = useRoute()
const router = useRouter()
const { data: nav } = useLiveQuery<Navigation>(getNavigation, { folders: [], replyLaterCount: 0, setAsideCount: 0 })

const SYSTEM_ICONS: Record<number, string> = { 1: '📥', 2: '🚫', 3: '🗑️' }

function icon(folder: FolderNavItem): string {
  return SYSTEM_ICONS[folder.id] ?? '📁'
}

function folderRoute(folder: FolderNavItem): string {
  return folder.id === 1 ? '/' : `/folder/${encodeURIComponent(folder.name.toLowerCase())}`
}

// The folder or queue being shown, from the page's address
const activeFolderId = computed(() => {
  if (route.path === '/') return 1
  if (route.name !== 'folder') return null
  const name = String(route.params.name ?? '').toLowerCase()
  return nav.value.folders.find(f => f.name.toLowerCase() === name)?.id ?? null
})
const activeQueue = computed(() =>
  route.path === '/reply-later' ? 'reply_later' : route.path === '/set-aside' ? 'set_aside' : null
)

function compose() {
  router.push(`/draft/${uuid()}`)
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span>MereMail</span>
      <SyncStatus class="sync" />
    </div>

    <button class="compose-btn" @click="compose">✏️ Compose</button>

    <nav class="section">
      <RouterLink
        v-for="folder in nav.folders.filter(f => f.isSystem)"
        :key="folder.id"
        :to="folderRoute(folder)"
        class="item"
        :class="{ active: activeFolderId === folder.id && !activeQueue }"
      >
        <span class="icon">{{ icon(folder) }}</span>
        <span class="label">{{ folder.name }}</span>
        <span v-if="folder.showUnreadCount && folder.unreadCount" class="count">{{ folder.unreadCount }}</span>
      </RouterLink>
      <RouterLink to="/reply-later" class="item" :class="{ active: activeQueue === 'reply_later' }">
        <span class="icon">⏰</span>
        <span class="label">Reply Later</span>
        <span v-if="nav.replyLaterCount" class="count">{{ nav.replyLaterCount }}</span>
      </RouterLink>
      <RouterLink to="/set-aside" class="item" :class="{ active: activeQueue === 'set_aside' }">
        <span class="icon">📌</span>
        <span class="label">Set Aside</span>
        <span v-if="nav.setAsideCount" class="count">{{ nav.setAsideCount }}</span>
      </RouterLink>
    </nav>

    <div class="heading">Folders</div>
    <nav class="section folders">
      <RouterLink
        v-for="folder in nav.folders.filter(f => !f.isSystem)"
        :key="folder.id"
        :to="folderRoute(folder)"
        class="item"
        :class="{ active: activeFolderId === folder.id && !activeQueue }"
        :title="folder.name"
      >
        <span class="icon">{{ icon(folder) }}</span>
        <span class="label">{{ folder.name }}</span>
        <span v-if="folder.showUnreadCount && folder.unreadCount" class="count">{{ folder.unreadCount }}</span>
      </RouterLink>
    </nav>

    <nav class="section footer">
      <RouterLink to="/contacts" class="item"><span class="icon">👤</span><span class="label">Contacts</span></RouterLink>
      <RouterLink to="/attachments" class="item"><span class="icon">📎</span><span class="label">Attachments</span></RouterLink>
      <RouterLink to="/rules" class="item"><span class="icon">⚙️</span><span class="label">Rules</span></RouterLink>
      <RouterLink to="/folders" class="item"><span class="icon">🗂️</span><span class="label">Manage folders</span></RouterLink>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 10px;
  background: var(--c-fafafa);
}

.brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 12px;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.sync {
  font-size: 11px;
}

.compose-btn {
  margin: 0 4px 14px;
  padding: 10px 12px;
  border: none;
  border-radius: 8px;
  background: var(--c-2563eb);
  color: var(--c-text-ffffff);
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.compose-btn:hover {
  background: var(--c-1d4ed8);
}

.heading {
  padding: 14px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--c-text-999999);
}

.section {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.section.folders {
  flex: 1;
}

.section.footer {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--c-e5e5e5);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 14px;
  color: var(--c-text-374151);
  text-decoration: none;
}

.item:hover {
  background: var(--c-f0f0f0);
}

.item.active,
.footer .item.router-link-active {
  background: var(--c-e5e7eb);
  color: var(--c-text-111111);
  font-weight: 600;
}

.icon {
  width: 18px;
  text-align: center;
  font-size: 13px;
  flex-shrink: 0;
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-2563eb);
}
</style>
