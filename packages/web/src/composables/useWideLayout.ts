import { ref, onMounted, onBeforeUnmount, type Ref } from 'vue'

/** Width from which the mail pages show folders, list and message side by side */
export const WIDE_LAYOUT_QUERY = '(min-width: 1100px)'

/** Whether the window is wide enough for the three-pane layout; updates on resize */
export function useWideLayout(): Ref<boolean> {
  const query = typeof window !== 'undefined' ? window.matchMedia(WIDE_LAYOUT_QUERY) : null
  const wide = ref(query?.matches ?? false)
  const update = (e: MediaQueryListEvent) => {
    wide.value = e.matches
  }
  onMounted(() => query?.addEventListener('change', update))
  onBeforeUnmount(() => query?.removeEventListener('change', update))
  return wide
}
