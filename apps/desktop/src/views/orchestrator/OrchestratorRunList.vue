<script setup lang="ts">
import { computed } from 'vue'
import type { OrchestratorRun } from '../../stores/orchestrator'

const props = defineProps<{
  runs: OrchestratorRun[]
  selectedId: string | null
  loading: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  refresh: []
}>()

const statusConfig: Record<string, { label: string, dot: string }> = {
  running: { label: '运行中', dot: 'bg-indigo-500 animate-pulse' },
  completed: { label: '已完成', dot: 'bg-emerald-500' },
  failed: { label: '失败', dot: 'bg-red-500' },
  blocked: { label: '阻塞', dot: 'bg-amber-500' },
  cancelled: { label: '已取消', dot: 'bg-gray-400' },
}

function formatTime(iso: string) {
  const normalized = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(normalized).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function parseDecisionType(run: OrchestratorRun): string {
  if (!run.leader_decision) return ''
  try {
    const d = JSON.parse(run.leader_decision)
    return d.decision === 'split' ? '拆分' : d.decision === 'single_worker' ? '单任务' : d.decision === 'blocked' ? '阻塞' : ''
  }
  catch { return '' }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200/60 dark:border-white/5">
      <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
        运行记录
      </span>
      <button
        class="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 text-gray-400 transition-colors"
        title="刷新"
        @click="emit('refresh')"
      >
        <div class="i-carbon-renew w-3.5 h-3.5" :class="loading && 'animate-spin'" />
      </button>
    </div>

    <div v-if="runs.length === 0 && !loading" class="flex-1 flex items-center justify-center px-4">
      <p class="text-xs text-gray-400 text-center">暂无运行记录</p>
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <button
        v-for="run in runs"
        :key="run.id"
        class="w-full text-left px-4 py-3 border-b border-gray-100 dark:border-white/3 transition-colors"
        :class="selectedId === run.id
          ? 'bg-indigo-50/60 dark:bg-indigo-500/8'
          : 'hover:bg-gray-50 dark:hover:bg-white/3'"
        @click="emit('select', run.id)"
      >
        <div class="flex items-center gap-2 mb-1">
          <span
            class="w-1.5 h-1.5 rounded-full flex-shrink-0"
            :class="statusConfig[run.status]?.dot ?? 'bg-gray-400'"
          />
          <span class="text-[13px] font-medium truncate">
            {{ run.requirement_id.slice(0, 8) }}…
          </span>
          <span
            v-if="parseDecisionType(run)"
            class="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400 flex-shrink-0"
          >
            {{ parseDecisionType(run) }}
          </span>
        </div>
        <div class="flex items-center gap-2 text-[11px] text-gray-400">
          <span>{{ statusConfig[run.status]?.label ?? run.status }}</span>
          <span>&middot;</span>
          <span>{{ formatTime(run.created_at) }}</span>
        </div>
      </button>
    </div>
  </div>
</template>
