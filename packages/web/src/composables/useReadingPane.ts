import { computed, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { useWideLayout } from '@/composables/useWideLayout'

/** Whether a key press is meant for a text field rather than the mail list */
export function isTyping(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  return !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/**
 * The reading pane beside a mail list on wide screens. The open thread lives
 * in the URL (?t=...), so Back and Forward step through what was read and a
 * reload keeps it open. j/k and the arrow keys step through `visibleIds`.
 */
export function useReadingPane(visibleIds: Ref<number[]>) {
  const route = useRoute()
  const router = useRouter()
  const wide = useWideLayout()

  const openThreadId = computed(() => {
    const raw = route.query.t
    const id = Number(typeof raw === 'string' ? raw : '')
    return wide.value && Number.isInteger(id) && id > 0 ? id : null
  })

  function threadQuery(threadId: number | null): LocationQueryRaw {
    const query: LocationQueryRaw = { ...route.query }
    if (threadId === null) delete query.t
    else query.t = String(threadId)
    return query
  }

  function readerLink(threadId: number) {
    return { query: threadQuery(threadId) }
  }

  function open(threadId: number | null) {
    router.replace({ query: threadQuery(threadId) })
  }

  function openNeighbour(step: 1 | -1) {
    const ids = visibleIds.value
    if (ids.length === 0) return
    const at = openThreadId.value === null ? -1 : ids.indexOf(openThreadId.value)
    const next = at === -1 ? (step === 1 ? 0 : ids.length - 1) : at + step
    if (next < 0 || next >= ids.length) return
    open(ids[next]!)
  }

  /**
   * Threads are about to leave the list (trashed, moved or deleted). If the
   * open one is among them, move on to the next thread that stays.
   */
  function onRemoving(removed: number[]) {
    const open_ = openThreadId.value
    if (open_ === null || !removed.includes(open_)) return
    const gone = new Set(removed)
    const ids = visibleIds.value
    const at = ids.indexOf(open_)
    let next: number | null = null
    if (at !== -1) {
      next = ids.slice(at + 1).find(id => !gone.has(id))
        ?? ids.slice(0, at).reverse().find(id => !gone.has(id))
        ?? null
    }
    open(next)
  }

  /** The reader closed its thread itself (trashed or deleted from within it) */
  function onReaderClose() {
    if (openThreadId.value !== null) onRemoving([openThreadId.value])
  }

  function onKeydown(e: KeyboardEvent) {
    if (!wide.value || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      openNeighbour(1)
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      openNeighbour(-1)
    } else if (e.key === 'Escape' && openThreadId.value !== null) {
      open(null)
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

  return { wide, openThreadId, threadQuery, readerLink, open, onRemoving, onReaderClose }
}
