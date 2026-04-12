<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { OrchestratorEvent } from '../../stores/orchestrator'

const props = defineProps<{
  events: OrchestratorEvent[]
}>()

const scrollContainer = ref<HTMLElement>()
const autoScroll = ref(true)

watch(() => props.events.length, async () => {
  if (!autoScroll.value) return
  await nextTick()
  if (scrollContainer.value)
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
})

const eventConfig: Record<string, { label: string, icon: string, color: string }> = {
  leader_started: { label: 'Leader 启动', icon: 'i-carbon-play', color: 'text-indigo-500' },
  leader_agent_error: { label: 'Leader Agent 错误', icon: 'i-carbon-error', color: 'text-red-500' },
  leader_output_invalid: { label: 'Leader 输出无效', icon: 'i-carbon-warning', color: 'text-amber-500' },
  requirement_analyzed: { label: '需求分析完成', icon: 'i-carbon-analytics', color: 'text-blue-500' },
  task_assigned: { label: '任务已分配', icon: 'i-carbon-task', color: 'text-indigo-500' },
  worker_started: { label: 'Worker 启动', icon: 'i-carbon-play', color: 'text-cyan-500' },
  worker_output: { label: 'Worker 输出', icon: 'i-carbon-terminal', color: 'text-gray-500' },
  worker_completed: { label: 'Worker 完成', icon: 'i-carbon-checkmark', color: 'text-emerald-500' },
  worker_failed: { label: 'Worker 失败', icon: 'i-carbon-error', color: 'text-red-500' },
  worker_timeout: { label: 'Worker 超时', icon: 'i-carbon-timer', color: 'text-amber-500' },
  run_completed: { label: '运行完成', icon: 'i-carbon-checkmark-filled', color: 'text-emerald-500' },
  run_failed: { label: '运行失败', icon: 'i-carbon-error-filled', color: 'text-red-500' },
  run_blocked: { label: '运行阻塞', icon: 'i-carbon-warning-filled', color: 'text-amber-500' },
  run_cancelled: { label: '运行已取消', icon: 'i-carbon-close-filled', color: 'text-gray-500' },
  run_rejected: { label: '运行被拒绝', icon: 'i-carbon-thumbs-down', color: 'text-red-500' },
}

function formatTime(iso: string) {
  const normalized = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(normalized).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function parsePayload(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null
  try { return JSON.parse(payload) }
  catch { return null }
}

function payloadSummary(payload: Record<string, unknown>): string {
  const parts: string[] = []
  if (payload.role) parts.push(`角色: ${payload.role}`)
  if (payload.title) parts.push(String(payload.title))
  if (payload.reason) parts.push(String(payload.reason))
  if (payload.error) parts.push(String(payload.error))
  if (payload.decision) parts.push(`决策: ${payload.decision}`)
  if (payload.feedback) parts.push(String(payload.feedback))
  return parts.join(' · ') || JSON.stringify(payload).slice(0, 120)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-gray-200/60 dark:border-white/5">
      <span class="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
        事件日志
      </span>
      <label class="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
        <input v-model="autoScroll" type="checkbox" class="w-3 h-3 rounded accent-indigo-500">
        自动滚动
      </label>
    </div>

    <div v-if="events.length === 0" class="flex-1 flex items-center justify-center">
      <p class="text-xs text-gray-400">暂无事件</p>
    </div>

    <div v-else ref="scrollContainer" class="flex-1 overflow-y-auto px-4 py-2 space-y-1">
      <div
        v-for="event in events"
        :key="event.id"
        class="flex items-start gap-2 py-1.5"
      >
        <div
          :class="[eventConfig[event.event_type]?.icon ?? 'i-carbon-circle-dash', eventConfig[event.event_type]?.color ?? 'text-gray-400']"
          class="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-[12px] font-medium">
              {{ eventConfig[event.event_type]?.label ?? event.event_type }}
            </span>
            <span class="text-[10px] text-gray-400">{{ formatTime(event.created_at) }}</span>
          </div>
          <p
            v-if="parsePayload(event.payload)"
            class="text-[11px] text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words"
          >
            {{ payloadSummary(parsePayload(event.payload)!) }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
