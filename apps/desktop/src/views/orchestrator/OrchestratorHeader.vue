<script setup lang="ts">
import { useOrchestratorStore } from '../../stores/orchestrator'

const store = useOrchestratorStore()

const statusDot: Record<string, string> = {
  running: 'bg-emerald-500 animate-pulse',
  stopped: 'bg-gray-400',
}
</script>

<template>
  <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200/60 dark:border-white/5">
    <div class="flex items-center gap-3">
      <h2 class="text-lg font-semibold tracking-tight">多 Agent 编排</h2>
      <div v-if="store.status" class="flex items-center gap-2 text-xs">
        <span
          class="w-2 h-2 rounded-full"
          :class="statusDot[store.isRunning ? 'running' : 'stopped']"
        />
        <span class="text-gray-500 dark:text-gray-400">
          {{ store.isRunning ? '运行中' : '已停止' }}
        </span>
        <span
          v-if="store.status.teamName"
          class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400"
        >
          {{ store.status.teamName }}
        </span>
      </div>
      <span
        v-else
        class="text-xs text-gray-400"
      >
        未配置 team.yaml
      </span>
    </div>

    <div v-if="store.status" class="flex items-center gap-2">
      <button
        v-if="!store.isRunning"
        class="px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
        @click="store.start()"
      >
        启动
      </button>
      <button
        v-else
        class="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20 transition-colors"
        @click="store.stop()"
      >
        停止
      </button>
    </div>
  </div>
</template>
