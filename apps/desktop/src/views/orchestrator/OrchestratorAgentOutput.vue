<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted, onMounted } from 'vue'
import { useOrchestratorStore } from '../../stores/orchestrator'

const props = defineProps<{
  runId: string
  assignmentId?: string
  label: string
  active: boolean
}>()

const store = useOrchestratorStore()
const scrollContainer = ref<HTMLElement>()
const autoScroll = ref(true)
let pollTimer: ReturnType<typeof setInterval> | null = null

const output = ref('')

async function poll() {
  try {
    await store.fetchAgentOutput(props.runId, props.assignmentId)
    output.value = store.getAgentOutput(props.runId, props.assignmentId)
  }
  catch { /* ignore polling errors */ }
}

watch(() => props.active, (active) => {
  if (active) {
    poll()
    pollTimer = setInterval(poll, 2000)
  }
  else if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}, { immediate: true })

watch(output, async () => {
  if (!autoScroll.value) return
  await nextTick()
  if (scrollContainer.value)
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
})

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  autoScroll.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
}

onMounted(() => {
  if (props.active) {
    poll()
    if (!pollTimer) pollTimer = setInterval(poll, 2000)
  }
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="flex flex-col border border-gray-200/60 dark:border-white/5 rounded-lg overflow-hidden">
    <div class="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-white/3 border-b border-gray-200/40 dark:border-white/5">
      <span class="text-[11px] font-medium text-gray-500 dark:text-gray-400">{{ label }}</span>
      <div class="flex items-center gap-2">
        <span v-if="output" class="text-[10px] text-gray-400 font-mono">
          {{ output.length.toLocaleString() }} 字符
        </span>
        <button
          class="text-[10px] px-1.5 py-0.5 rounded transition-colors"
          :class="autoScroll
            ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400'
            : 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400'"
          @click="autoScroll = !autoScroll"
        >
          {{ autoScroll ? '自动滚动' : '手动滚动' }}
        </button>
      </div>
    </div>

    <div
      ref="scrollContainer"
      class="overflow-y-auto font-mono text-xs leading-relaxed p-3 bg-gray-900 text-gray-200 whitespace-pre-wrap break-all"
      style="max-height: 400px; min-height: 120px;"
      @scroll="onScroll"
    >
      <template v-if="output">{{ output }}</template>
      <div v-else class="text-gray-500 italic">等待输出…</div>
    </div>
  </div>
</template>
