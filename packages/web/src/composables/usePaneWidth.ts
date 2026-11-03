import { ref, watch, type Ref } from 'vue'

/**
 * A pane width the user can drag, remembered on this device.
 * Returns the width in pixels, kept within [min, max].
 */
export function usePaneWidth(key: string, initial: number, min: number, max: number): Ref<number> {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))
  let stored = initial
  try {
    const saved = Number(localStorage.getItem(key))
    if (Number.isFinite(saved) && saved > 0) stored = saved
  } catch {
    // Storage unavailable: use the default
  }
  const width = ref(clamp(stored))
  watch(width, (w) => {
    try {
      localStorage.setItem(key, String(w))
    } catch {
      // Not remembered, but still works
    }
  })
  return width
}

/** Default widths of the folder sidebar and the mail list on wide screens */
export const SIDEBAR_WIDTH = 230
export const LIST_WIDTH = 400
