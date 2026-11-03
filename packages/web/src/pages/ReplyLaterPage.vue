<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ThreadList from '@/components/ThreadList.vue'
import RefreshButton from '@/components/RefreshButton.vue'
import FolderNav from '@/components/FolderNav.vue'
import ReaderPane from '@/components/ReaderPane.vue'
import PaneResizer from '@/components/PaneResizer.vue'
import { useReadingPane } from '@/composables/useReadingPane'
import { usePaneWidth, LIST_WIDTH } from '@/composables/usePaneWidth'

const listIds = ref<number[]>([])
const { wide, openThreadId, readerLink, onRemoving, onReaderClose } = useReadingPane(listIds)
const listWidth = usePaneWidth('meremail.listWidth', LIST_WIDTH, 280, 900)

onMounted(() => {
  document.title = 'Reply Later - MereMail'
})
</script>

<template>
  <div class="page" :class="{ split: wide }" :style="wide ? { gridTemplateColumns: `${listWidth}px 1px minmax(0, 1fr)` } : undefined">
    <section class="list-pane">
      <header class="header">
        <div class="title-row">
          <h1>Reply Later</h1>
          <RefreshButton />
        </div>
        <FolderNav v-if="!wide" active-queue="reply_later" />
      </header>

      <main class="main">
        <ThreadList
          queue="reply_later"
          empty-message="No threads in your reply later queue"
          :link-for="wide ? readerLink : undefined"
          :active-id="openThreadId"
          @threads="listIds = $event"
          @removing="onRemoving"
        />
      </main>
    </section>

    <PaneResizer v-if="wide" v-model="listWidth" :min="280" :max="900" :default-width="LIST_WIDTH" />
    <ReaderPane v-if="wide" :thread-id="openThreadId" @close="onReaderClose" />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding-bottom: 80px;
}

.page.split {
  display: grid;
  height: 100vh;
  min-height: 0;
  padding-bottom: 0;
  overflow: hidden;
}

.page.split .list-pane {
  height: 100vh;
  min-width: 0;
  overflow-y: auto;
}

.header {
  padding: 24px 20px 16px;
  border-bottom: 1px solid var(--c-e5e5e5);
}

.page.split .header {
  padding: 18px 20px 12px;
}

.header h1 {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 16px 0;
}

.page.split .header h1 {
  margin: 0;
}

.main {
  padding: 0;
}

.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header .title-row {
  margin-bottom: 16px;
}

.header .title-row h1,
.page.split .header .title-row {
  margin: 0;
}
</style>
