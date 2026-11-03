<script setup lang="ts">
/**
 * A vertical handle between two panes. Drag it to resize the pane on its
 * left; double-click to put the pane back to its default width.
 */
const props = defineProps<{
  modelValue: number
  min: number
  max: number
  defaultWidth: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', width: number): void
}>()

function clamp(n: number) {
  return Math.min(props.max, Math.max(props.min, Math.round(n)))
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  const startX = e.clientX
  const startWidth = props.modelValue
  document.body.classList.add('resizing-panes')

  const move = (ev: PointerEvent) => emit('update:modelValue', clamp(startWidth + ev.clientX - startX))
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    document.body.classList.remove('resizing-panes')
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}

function onKeydown(e: KeyboardEvent) {
  const step = e.shiftKey ? 50 : 10
  if (e.key === 'ArrowLeft') emit('update:modelValue', clamp(props.modelValue - step))
  else if (e.key === 'ArrowRight') emit('update:modelValue', clamp(props.modelValue + step))
  else return
  e.preventDefault()
  e.stopPropagation()
}
</script>

<template>
  <div
    class="pane-resizer"
    role="separator"
    aria-orientation="vertical"
    :aria-valuenow="modelValue"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    title="Drag to resize (double-click to reset)"
    @pointerdown="onPointerDown"
    @dblclick="emit('update:modelValue', clamp(defaultWidth))"
    @keydown="onKeydown"
  ></div>
</template>

<style scoped>
.pane-resizer {
  position: relative;
  width: 1px;
  height: 100vh;
  background: var(--c-e5e5e5);
  cursor: col-resize;
  z-index: 10;
  touch-action: none;
}

/* A wider grab area than the 1px line */
.pane-resizer::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  right: -4px;
}

.pane-resizer:hover,
.pane-resizer:focus-visible,
:global(body.resizing-panes) .pane-resizer:active {
  background: var(--c-2563eb);
  outline: none;
  box-shadow: 0 0 0 1px var(--c-2563eb);
}

:global(body.resizing-panes) {
  cursor: col-resize;
  user-select: none;
}

:global(body.resizing-panes iframe) {
  pointer-events: none;
}
</style>
