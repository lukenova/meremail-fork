<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { enqueue } from '@/local/actions'
import { db } from '@/local/db'
import { useLiveQuery } from '@/local/live'
import { listFolderThreads, listReplyLater, type ThreadListItem } from '@/local/queries'
import { getWatermark } from '@/local/store'
import { isSyncing, loadOlderThreads } from '@/local/sync'
import { formatListDate } from '@/utils/format'
import { isTyping } from '@/composables/useReadingPane'

const props = defineProps<{
  folderId?: number
  queue?: 'reply_later'
  emptyMessage?: string
  unreadOnly?: boolean
  /** Where a thread links to, instead of its own page (e.g. the reading pane) */
  linkFor?: (threadId: number) => RouteLocationRaw
  /** The thread open in the reading pane, highlighted in the list */
  activeId?: number | null
}>()

const emit = defineEmits<{
  /** The threads shown, in order - for stepping through them with the keyboard */
  (e: 'threads', ids: number[]): void
  /** These threads are about to leave the list (trashed, deleted or moved away) */
  (e: 'removing', ids: number[]): void
}>()

// Folders that aren't kept offline are browsed straight from the server:
// each visit pages in from the top, and this is how far back it has got.
// Null until the first page has arrived.
const browsedTo = ref<number | null>(null)
const loadingMore = ref(false)
const loadMoreError = ref<string | null>(null)

interface ListState {
  threads: ThreadListItem[]
  /** Whether the server may have older threads than the ones shown */
  hasMore: boolean
  keptOffline: boolean
}

const { data: list, loaded } = useLiveQuery<ListState>(async () => {
  if (props.queue === 'reply_later') {
    // Everything in the queue is always held locally
    return { threads: await listReplyLater(), hasMore: false, keptOffline: true }
  }

  const folderId = props.folderId ?? 1
  const folder = await db.folders.get(folderId)
  const keptOffline = folder?.syncOffline !== false

  if (keptOffline) {
    const watermark = await getWatermark(folderId)
    return {
      threads: await listFolderThreads(folderId, { unreadOnly: props.unreadOnly }),
      hasMore: watermark > 0,
      keptOffline,
    }
  }

  // Until the first page arrives (or if we're offline), show whatever happens to be held
  return {
    threads: await listFolderThreads(folderId, { from: browsedTo.value ?? 0, unreadOnly: props.unreadOnly }),
    hasMore: browsedTo.value === null || browsedTo.value > 0,
    keptOffline,
  }
}, { threads: [], hasMore: false, keptOffline: true }, [browsedTo])

const threads = computed(() => list.value.threads)

async function loadMore() {
  if (loadingMore.value || props.folderId === undefined) return
  loadingMore.value = true
  loadMoreError.value = null

  try {
    if (list.value.keptOffline) {
      await loadOlderThreads(props.folderId, await getWatermark(props.folderId), { remember: true })
    } else {
      browsedTo.value = (await loadOlderThreads(props.folderId, browsedTo.value, { remember: false })) ?? 0
    }
  } catch (e) {
    console.error('Failed to load more threads:', e)
    loadMoreError.value = 'Older mail couldn\'t be loaded. It needs a connection to the server.'
  } finally {
    loadingMore.value = false
  }
}

// ============== Selection ==============

const TRASH_FOLDER_ID = 3

/**
 * Desktop lists (beside the reading pane) select like a desktop mail client:
 * Ctrl+click, Shift+click, Ctrl+Shift+Home/End, Ctrl+A, and the Delete key.
 * Elsewhere a long press or the Select button starts a touch-style selection.
 */
const desktop = computed(() => !!props.linkFor)

const selecting = ref(false)
const selected = ref(new Set<number>())
const showMoveMenu = ref(false)
const working = ref(false)
/** Where Shift+click and Ctrl+Shift+Home/End select from */
const anchorId = ref<number | null>(null)

const { data: allFolders } = useLiveQuery(() => db.folders.orderBy('position').toArray(), [])
const moveTargets = computed(() => allFolders.value.filter(f => f.id !== props.folderId && f.id !== TRASH_FOLDER_ID))
const inTrash = computed(() => props.folderId === TRASH_FOLDER_ID)

/** Threads that can be selected (drafts have their own page and actions) */
const selectableIds = computed(() => threads.value.filter(t => t.type !== 'draft').map(t => t.id as number))
const allSelected = computed(() => selectableIds.value.length > 0 && selectableIds.value.every(id => selected.value.has(id)))

/** What the action buttons act on: the selection, or else the open thread */
const targets = computed<number[]>(() => {
  if (selected.value.size > 0) return selectableIds.value.filter(id => selected.value.has(id))
  if (desktop.value && props.activeId != null && selectableIds.value.includes(props.activeId)) return [props.activeId]
  return []
})

watch(selectableIds, (ids) => emit('threads', ids), { immediate: true })

function threadLink(thread: ThreadListItem): RouteLocationRaw {
  if (thread.type === 'draft') return `/draft/${thread.id}`
  return props.linkFor ? props.linkFor(thread.id as number) : `/thread/${thread.id}`
}

// Forget threads that left the list (moved or deleted elsewhere)
watch(selectableIds, (ids) => {
  const present = new Set(ids)
  const kept = [...selected.value].filter(id => present.has(id))
  if (kept.length !== selected.value.size) selected.value = new Set(kept)
  if (desktop.value && selecting.value && kept.length === 0) selecting.value = false
})

function select(ids: Iterable<number>) {
  selected.value = new Set(ids)
  selecting.value = selected.value.size > 0 || !desktop.value
}

function startSelecting(id?: number) {
  selecting.value = true
  if (id !== undefined) {
    selected.value = new Set([id])
    anchorId.value = id
  }
}

function stopSelecting() {
  selecting.value = false
  showMoveMenu.value = false
  selected.value = new Set()
}

function toggle(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  anchorId.value = id
  select(next)
}

function toggleAll() {
  select(allSelected.value ? [] : selectableIds.value)
}

/** Select every thread between the anchor and `id`, inclusive */
function selectRange(id: number, keep = false) {
  const ids = selectableIds.value
  const from = ids.indexOf(anchorId.value ?? props.activeId ?? id)
  const to = ids.indexOf(id)
  if (to === -1) return
  const start = from === -1 ? to : from
  const range = ids.slice(Math.min(start, to), Math.max(start, to) + 1)
  select(keep ? [...selected.value, ...range] : range)
}

function onRowClick(event: MouseEvent, thread: ThreadListItem) {
  if (thread.type === 'draft') return
  const id = thread.id as number

  if (desktop.value) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      // The first Ctrl+click adds to the thread already open, like other mail clients
      if (selected.value.size === 0 && props.activeId != null && props.activeId !== id && selectableIds.value.includes(props.activeId)) {
        selected.value = new Set([props.activeId])
      }
      toggle(id)
    } else if (event.shiftKey) {
      event.preventDefault()
      selectRange(id)
    } else {
      // A plain click opens the thread and drops the selection
      if (selecting.value) stopSelecting()
      anchorId.value = id
    }
    return
  }

  if (selecting.value) toggle(id)
}

// Right-click a row to start selecting on desktop
function onContextMenu(event: MouseEvent, thread: ThreadListItem) {
  if (selecting.value || thread.type === 'draft') return
  event.preventDefault()
  startSelecting(thread.id as number)
}

// Long-press a row to start selecting on touch screens
let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressFired = false
function onPressStart(thread: ThreadListItem) {
  if (selecting.value || thread.type === 'draft') return
  pressFired = false
  pressTimer = setTimeout(() => {
    pressFired = true
    startSelecting(thread.id as number)
    navigator.vibrate?.(20)
  }, 500)
}
function onPressEnd(event?: Event) {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
  if (pressFired && event) {
    event.preventDefault()
    pressFired = false
  }
}

async function run(ids: number[], each: (threadId: number) => Promise<void>, removes: boolean) {
  if (working.value || ids.length === 0) return
  working.value = true
  try {
    // Let the reading pane move on before the threads disappear from the list
    if (removes) emit('removing', ids)
    for (const id of ids) await each(id)
    stopSelecting()
  } finally {
    working.value = false
  }
}

/** Trash these threads, or in Trash, delete them for good (after asking) */
function removeThreads(ids: number[]) {
  const n = ids.length
  if (n === 0) return
  if (inTrash.value) {
    if (!confirm(`Delete ${n} conversation${n === 1 ? '' : 's'} forever? This also deletes ${n === 1 ? 'it' : 'them'} from the mail server.`)) return
    return run(ids, threadId => enqueue({ type: 'thread.delete', payload: { threadId } }), true)
  }
  return run(ids, threadId => enqueue({ type: 'thread.trash', payload: { threadId } }), true)
}

function deleteSelected() {
  return removeThreads(targets.value)
}

function moveSelected(folderId: number) {
  showMoveMenu.value = false
  // Moving out of a folder takes threads off this list; a queue keeps them
  return run(targets.value, threadId => enqueue({ type: 'thread.move', payload: { threadId, folderId } }), props.folderId !== undefined)
}

async function markSelectedRead() {
  const ids = targets.value
  if (working.value || ids.length === 0) return
  const emails = await db.emails.where('threadId').anyOf(ids).filter(e => e.unread === 1).toArray()
  if (emails.length) await enqueue({ type: 'emails.markRead', payload: { emailIds: emails.map(e => e.id) } })
  stopSelecting()
}

function onKeydown(e: KeyboardEvent) {
  if (!desktop.value || e.altKey || isTyping(e)) return
  const mod = e.ctrlKey || e.metaKey

  if (e.key === 'Escape' && selecting.value) {
    e.preventDefault()
    e.stopImmediatePropagation()
    stopSelecting()
  } else if (mod && e.shiftKey && (e.key === 'Home' || e.key === 'End')) {
    const ids = selectableIds.value
    if (ids.length === 0) return
    e.preventDefault()
    const anchor = anchorId.value ?? props.activeId ?? null
    const at = anchor === null ? -1 : ids.indexOf(anchor)
    if (at === -1) select(e.key === 'Home' ? ids.slice(0, 1) : ids.slice(-1))
    else select(e.key === 'Home' ? ids.slice(0, at + 1) : ids.slice(at))
  } else if (mod && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
    if (selectableIds.value.length === 0) return
    e.preventDefault()
    select(selectableIds.value)
  } else if (e.key === 'Delete' || (e.key === 'Backspace' && !e.shiftKey)) {
    if (targets.value.length === 0) return
    e.preventDefault()
    deleteSelected()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function getParticipantDisplay(participants: ThreadListItem['participants']): string {
  if (participants.length === 0) return 'Unknown'
  const names = participants
    .slice(0, 3)
    .map((p) => p.name || p.email.split('@')[0])
  if (participants.length > 3) {
    return `${names.join(', ')} +${participants.length - 3}`
  }
  return names.join(', ')
}

onMounted(async () => {
  if (props.folderId === undefined) return
  const folder = await db.folders.get(props.folderId)
  if (folder && !folder.syncOffline) {
    loadMore()
  }
})
</script>

<template>
  <div class="thread-list-container">
    <div v-if="!loaded" class="loading">Loading...</div>

    <div v-else-if="threads.length === 0 && (isSyncing || loadingMore)" class="loading">
      Syncing...
    </div>

    <div v-else-if="threads.length === 0 && !list.hasMore" class="empty">
      {{ emptyMessage || 'No threads' }}
    </div>

    <!-- Desktop: a toolbar that acts on the selection, or else the open thread -->
    <div v-if="desktop && threads.length > 0 && selectableIds.length > 0" class="select-bar desk-bar" :class="{ active: selecting }">
      <label class="select-all" title="Select all (Ctrl+A)">
        <input type="checkbox" :checked="allSelected" :indeterminate="selected.size > 0 && !allSelected" @change="toggleAll" />
        <span v-if="selected.size > 0">{{ selected.size }} selected</span>
      </label>
      <div class="select-actions">
        <button class="icon-btn" :disabled="targets.length === 0 || working" title="Mark read" aria-label="Mark read" @click="markSelectedRead">✓</button>
        <div class="move-wrap">
          <button class="icon-btn" :disabled="targets.length === 0 || working" title="Move to folder" aria-label="Move to folder" @click="showMoveMenu = !showMoveMenu">📁 &#9662;</button>
          <ul v-if="showMoveMenu" class="move-menu">
            <li v-for="f in moveTargets" :key="f.id">
              <button @click="moveSelected(f.id)">{{ f.name }}</button>
            </li>
          </ul>
        </div>
        <button
          class="icon-btn danger"
          :disabled="targets.length === 0 || working"
          :title="inTrash ? 'Delete forever (Delete key)' : 'Delete (Delete key)'"
          :aria-label="inTrash ? 'Delete forever' : 'Delete'"
          @click="deleteSelected"
        >🗑️</button>
        <button v-if="selecting" class="icon-btn" title="Clear selection (Esc)" aria-label="Clear selection" @click="stopSelecting">✕</button>
      </div>
    </div>

    <div v-if="!desktop && threads.length > 0 && selectableIds.length > 0" class="select-bar" :class="{ active: selecting }">
      <template v-if="!selecting">
        <button class="select-btn" @click="startSelecting()">Select</button>
      </template>
      <template v-else>
        <label class="select-all">
          <input type="checkbox" :checked="allSelected" @change="toggleAll" />
          <span>{{ selected.size }} selected</span>
        </label>
        <div class="select-actions">
          <button class="bar-btn" :disabled="selected.size === 0 || working" @click="markSelectedRead">Mark read</button>
          <div class="move-wrap">
            <button class="bar-btn" :disabled="selected.size === 0 || working" @click="showMoveMenu = !showMoveMenu">Move to &#9662;</button>
            <ul v-if="showMoveMenu" class="move-menu">
              <li v-for="f in moveTargets" :key="f.id">
                <button @click="moveSelected(f.id)">{{ f.name }}</button>
              </li>
            </ul>
          </div>
          <button class="bar-btn danger" :disabled="selected.size === 0 || working" @click="deleteSelected">
            {{ inTrash ? 'Delete forever' : 'Delete' }}
          </button>
          <button class="bar-btn" @click="stopSelecting">Cancel</button>
        </div>
      </template>
    </div>

    <ul v-if="threads.length > 0" class="thread-list" :class="{ selecting, desktop }">
      <li
        v-for="thread in threads"
        :key="`${thread.type}-${thread.id}`"
        class="thread-item"
        :class="{
          unread: thread.unreadCount > 0,
          'is-draft': thread.type === 'draft' && thread.draftCount > 0,
          'is-queued': thread.queuedCount > 0,
          'has-draft': thread.type !== 'draft' && thread.draftCount > 0,
          selected: selecting && thread.type !== 'draft' && selected.has(thread.id as number),
          active: thread.type !== 'draft' && activeId === thread.id && (desktop || !selecting)
        }"
      >
        <input
          v-if="selecting && thread.type !== 'draft'"
          type="checkbox"
          class="row-check"
          :checked="selected.has(thread.id as number)"
          :aria-label="`Select ${thread.subject}`"
          @change="toggle(thread.id as number)"
        />
        <component
          :is="!desktop && selecting && thread.type !== 'draft' ? 'div' : RouterLink"
          v-bind="!desktop && selecting && thread.type !== 'draft' ? {} : { to: threadLink(thread) }"
          class="thread-link"
          @click="onRowClick($event, thread)"
          @touchstart.passive="onPressStart(thread)"
          @touchend="onPressEnd($event)"
          @touchmove.passive="onPressEnd()"
          @contextmenu="onContextMenu($event, thread)"
        >
          <div class="thread-header">
            <span class="thread-participants">
              <span v-if="thread.queuedCount > 0" class="queued-badge">Queued</span>
              <span v-else-if="thread.type === 'draft'" class="draft-badge">Draft</span>
              {{ thread.type === 'draft' && thread.participants.length === 0
                ? 'New Message'
                : getParticipantDisplay(thread.participants) }}
              <span v-if="thread.type !== 'draft' && thread.draftCount > 0" class="has-draft-indicator">Draft</span>
            </span>
            <span class="thread-date">
              {{ formatListDate(thread.latestAt) }}
            </span>
          </div>
          <div class="thread-subject">
            {{ thread.subject }}
            <span v-if="thread.unreadCount > 0" class="unread-count">
              ({{ thread.unreadCount }})
            </span>
          </div>
          <div class="thread-snippet">
            {{ thread.snippet || '(No content)' }}
          </div>
        </component>
        <button
          v-if="desktop && thread.type !== 'draft'"
          class="row-trash"
          :title="inTrash ? 'Delete forever' : 'Delete'"
          :aria-label="inTrash ? `Delete ${thread.subject} forever` : `Delete ${thread.subject}`"
          :disabled="working"
          @click.prevent.stop="removeThreads([thread.id as number])"
        >🗑️</button>
      </li>
    </ul>

    <div v-if="loadMoreError" class="cache-notice">
      {{ loadMoreError }}
    </div>

    <div v-if="loaded && list.hasMore && !(threads.length === 0 && loadingMore)" class="load-more">
      <button @click="loadMore" :disabled="loadingMore" class="load-more-btn">
        {{ loadingMore ? 'Loading...' : 'Load older' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.loading,
.error,
.empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--c-text-666666);
}

.error {
  color: var(--c-text-991b1b);
}

.thread-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.thread-item {
  border-bottom: 1px solid var(--c-f0f0f0);
  position: relative;
}

.thread-list.selecting .thread-item {
  display: flex;
  align-items: center;
}

.thread-list.selecting .thread-link {
  flex: 1;
  min-width: 0;
  padding-left: 8px;
}

.row-check {
  margin-left: 20px;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  cursor: pointer;
}

.thread-item.active {
  background: var(--c-eff6ff);
  box-shadow: inset 3px 0 0 var(--c-2563eb);
}

.thread-item.selected {
  background: var(--c-eff6ff);
}

.select-bar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--c-f0f0f0);
  flex-wrap: wrap;
}

.select-bar.active {
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--c-ffffff);
}

.select-btn,
.bar-btn {
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid var(--c-e5e5e5);
  border-radius: 6px;
  background: var(--c-ffffff);
  color: var(--c-text-333333);
  cursor: pointer;
}

.bar-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.bar-btn.danger {
  color: var(--c-text-dc2626);
  border-color: var(--c-fecaca);
}

.select-all {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--c-text-333333);
  cursor: pointer;
}

.select-all input {
  width: 18px;
  height: 18px;
}

.select-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.move-wrap {
  position: relative;
}

.move-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  list-style: none;
  margin: 0;
  padding: 4px 0;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--c-ffffff);
  border: 1px solid var(--c-e5e5e5);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 10;
}

.move-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 14px;
  font-size: 14px;
  border: none;
  background: none;
  color: var(--c-text-333333);
  cursor: pointer;
}

.move-menu button:hover {
  background: var(--c-f5f5f5);
}

.thread-item.unread .thread-participants {
  font-weight: 700;
}

.thread-item.unread .thread-subject {
  font-weight: 700;
}

.thread-item:not(.unread) .thread-participants,
.thread-item:not(.unread) .thread-subject,
.thread-item:not(.unread) .thread-snippet {
  color: var(--c-text-888888);
}

.thread-item:not(.unread) .thread-participants {
  font-weight: 500;
}

.thread-link {
  display: block;
  padding: 16px 20px;
  text-decoration: none;
  color: inherit;
  transition: background-color 0.1s ease;
}

.thread-link:focus:not(:focus-visible) {
  outline: none;
}

.thread-list.desktop .thread-link {
  user-select: none;
}

/* Desktop toolbar: icon buttons */
.desk-bar {
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--c-ffffff);
  padding: 6px 12px 6px 20px;
}

.desk-bar .select-all {
  min-height: 30px;
}

.icon-btn {
  min-width: 32px;
  height: 30px;
  padding: 0 8px;
  font-size: 14px;
  line-height: 1;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--c-text-333333);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--c-f0f0f0);
  border-color: var(--c-e5e5e5);
}

.icon-btn.danger:hover:not(:disabled) {
  background: var(--c-fef2f2);
  border-color: var(--c-fecaca);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* Desktop: a delete button appears on the row under the pointer */
.row-trash {
  position: absolute;
  right: 12px;
  bottom: 10px;
  width: 30px;
  height: 28px;
  border: 1px solid var(--c-e5e5e5);
  border-radius: 6px;
  background: var(--c-ffffff);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s ease;
}

.thread-item:hover .row-trash,
.row-trash:focus-visible {
  opacity: 1;
}

.row-trash:hover {
  background: var(--c-fef2f2);
  border-color: var(--c-fecaca);
}

div.thread-link {
  cursor: pointer;
  user-select: none;
}

.thread-link:hover {
  background-color: var(--c-fafafa);
}

.thread-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 4px;
}

.thread-participants {
  font-weight: 600;
  font-size: 14px;
  color: var(--c-text-1a1a1a);
}

.thread-date {
  font-size: 12px;
  color: var(--c-text-888888);
  flex-shrink: 0;
  margin-left: 12px;
}

.thread-subject {
  font-size: 14px;
  color: var(--c-text-333333);
  margin-bottom: 4px;
  font-weight: 500;
}

.unread-count {
  font-weight: 400;
  color: var(--c-text-666666);
}

.thread-snippet {
  font-size: 13px;
  color: var(--c-text-666666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.load-more {
  padding: 24px 20px;
  text-align: center;
  border-top: 1px solid var(--c-f0f0f0);
}

.load-more-btn {
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 500;
  color: var(--c-text-333333);
  background: var(--c-ffffff);
  border: 1px solid var(--c-dddddd);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--c-fafafa);
  border-color: var(--c-cccccc);
}

.load-more-btn:disabled {
  color: var(--c-text-999999);
  cursor: not-allowed;
}

.thread-item.is-draft {
  background: var(--c-fffbeb);
}

.thread-item.is-draft:hover {
  background: var(--c-fef3c7);
}

.draft-badge {
  display: inline-block;
  padding: 2px 6px;
  margin-right: 6px;
  background: var(--c-f59e0b);
  color: var(--c-text-ffffff);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  border-radius: 3px;
  vertical-align: middle;
}

.queued-badge {
  display: inline-block;
  padding: 2px 6px;
  margin-right: 6px;
  background: var(--c-3b82f6);
  color: var(--c-text-ffffff);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  border-radius: 3px;
  vertical-align: middle;
}

.thread-item.is-queued {
  background: var(--c-eff6ff);
}

.thread-item.is-queued:hover {
  background: var(--c-dbeafe);
}

.thread-item.has-draft {
  border-left: 3px solid var(--c-f59e0b);
}

.has-draft-indicator {
  display: inline-block;
  padding: 1px 5px;
  margin-left: 6px;
  background: transparent;
  color: var(--c-text-b45309);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  border: 1px solid var(--c-f59e0b);
  border-radius: 3px;
  vertical-align: middle;
}

.cache-notice {
  padding: 8px 20px;
  background: var(--c-fef3c7);
  color: var(--c-text-92400e);
  font-size: 13px;
  text-align: center;
  border-bottom: 1px solid var(--c-fde68a);
}
</style>
