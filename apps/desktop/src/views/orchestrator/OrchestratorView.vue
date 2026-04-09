<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useOrchestratorStore } from '../../stores/orchestrator'
import OrchestratorHeader from './OrchestratorHeader.vue'
import OrchestratorRunList from './OrchestratorRunList.vue'
import OrchestratorRunDetail from './OrchestratorRunDetail.vue'
import OrchestratorEventLog from './OrchestratorEventLog.vue'
import OrchestratorTeamConfig from './OrchestratorTeamConfig.vue'

type Tab = 'runs' | 'config'
const activeTab = ref<Tab>('runs')

const store = useOrchestratorStore()
const selectedRunId = ref<string | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function selectRun(id: string) {
  selectedRunId.value = id
  store.events = []
  await store.fetchRunDetail(id)
  await store.fetchEvents(id)
}

async function handleCancel(runId: string) {
  await store.cancelRun(runId)
}

async function handleReject(runId: string, feedback: string) {
  await store.rejectRun(runId, feedback)
}

async function handleRetry(assignmentId: string) {
  await store.retryAssignment(assignmentId)
}

async function refresh() {
  await store.fetchRuns()
  if (selectedRunId.value) {
    await store.fetchRunDetail(selectedRunId.value)
    await store.fetchEvents(selectedRunId.value)
  }
}

onMounted(async () => {
  await store.fetchStatus()
  await store.fetchRuns()

  pollTimer = setInterval(async () => {
    await store.fetchStatus()
    await store.fetchRuns()
    if (selectedRunId.value)
      await store.fetchEvents(selectedRunId.value)
  }, 5000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  store.clearSelection()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <OrchestratorHeader />

    <!-- Tabs -->
    <div class="flex items-center gap-0 px-5 border-b border-gray-200/60 dark:border-white/5">
      <button
        class="px-3 py-2 text-[13px] font-medium border-b-2 transition-colors"
        :class="activeTab === 'runs'
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'runs'"
      >
        运行记录
      </button>
      <button
        class="px-3 py-2 text-[13px] font-medium border-b-2 transition-colors"
        :class="activeTab === 'config'
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'config'"
      >
        团队配置
      </button>
    </div>

    <!-- Tab: Runs -->
    <div v-if="activeTab === 'runs'" class="flex-1 flex min-h-0">
      <!-- Left: Run list -->
      <div class="w-72 flex-shrink-0 border-r border-gray-200/60 dark:border-white/5">
        <OrchestratorRunList
          :runs="store.runs"
          :selected-id="selectedRunId"
          :loading="store.loading"
          @select="selectRun"
          @refresh="refresh"
        />
      </div>

      <!-- Right: Detail + Events -->
      <div class="flex-1 flex flex-col min-w-0">
        <template v-if="store.selectedRun">
          <!-- Run detail (upper) -->
          <div class="flex-1 min-h-0">
            <OrchestratorRunDetail
              :run="store.selectedRun"
              :assignments="store.selectedRunAssignments"
              @cancel="handleCancel"
              @reject="handleReject"
              @retry="handleRetry"
            />
          </div>

          <!-- Event log (lower) -->
          <div class="h-56 flex-shrink-0 border-t border-gray-200/60 dark:border-white/5">
            <OrchestratorEventLog :events="store.events" />
          </div>
        </template>

        <!-- Empty state -->
        <div v-else class="flex-1 flex items-center justify-center">
          <div class="text-center">
            <div class="i-carbon-flow w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
            <p class="text-sm text-gray-400">选择一条运行记录查看详情</p>
            <p class="text-xs text-gray-400/60 mt-1">
              {{ store.isRunning ? 'Orchestrator 正在轮询中…' : '启动 Orchestrator 开始自动处理需求' }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Config -->
    <div v-else-if="activeTab === 'config'" class="flex-1 min-h-0">
      <OrchestratorTeamConfig />
    </div>
  </div>
</template>
