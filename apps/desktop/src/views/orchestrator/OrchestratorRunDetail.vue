<script setup lang="ts">
import { computed, ref } from 'vue'
import type { OrchestratorRun, Assignment } from '../../stores/orchestrator'
import OrchestratorRejectDialog from './OrchestratorRejectDialog.vue'
import OrchestratorAgentOutput from './OrchestratorAgentOutput.vue'

const props = defineProps<{
  run: OrchestratorRun
  assignments: Assignment[]
}>()

const emit = defineEmits<{
  cancel: [runId: string]
  reject: [runId: string, feedback: string]
  retry: [assignmentId: string]
  retryRun: [runId: string]
}>()

const showRejectDialog = ref(false)
const showLeaderOutput = ref(false)
const expandedAssignments = ref<Set<string>>(new Set())

function toggleAssignmentOutput(id: string) {
  const s = new Set(expandedAssignments.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedAssignments.value = s
}

const statusBadge: Record<string, { label: string, class: string }> = {
  running: { label: '运行中', class: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400' },
  completed: { label: '已完成', class: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' },
  failed: { label: '失败', class: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' },
  blocked: { label: '阻塞', class: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400' },
  cancelled: { label: '已取消', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
  pending: { label: '待执行', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
}

const assignmentStatusBadge: Record<string, { label: string, class: string, icon: string }> = {
  pending: { label: '待执行', class: 'text-gray-500', icon: 'i-carbon-time' },
  running: { label: '运行中', class: 'text-indigo-500', icon: 'i-carbon-in-progress' },
  completed: { label: '已完成', class: 'text-emerald-500', icon: 'i-carbon-checkmark' },
  failed: { label: '失败', class: 'text-red-500', icon: 'i-carbon-error' },
  cancelled: { label: '已取消', class: 'text-gray-400', icon: 'i-carbon-close' },
}

const leaderDecision = computed(() => {
  if (!props.run.leader_decision) return null
  try { return JSON.parse(props.run.leader_decision) }
  catch { return null }
})

function formatTime(iso: string | null) {
  if (!iso) return '-'
  const normalized = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(normalized).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function handleReject(feedback: string) {
  showRejectDialog.value = false
  emit('reject', props.run.id, feedback)
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <!-- Run info -->
    <div class="px-5 py-4 border-b border-gray-200/60 dark:border-white/5">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span
            class="text-[11px] font-medium px-2 py-0.5 rounded-full"
            :class="statusBadge[run.status]?.class"
          >
            {{ statusBadge[run.status]?.label ?? run.status }}
          </span>
          <span class="text-xs text-gray-400 font-mono">{{ run.id.slice(0, 12) }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <button
            v-if="run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled'"
            class="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-400 dark:hover:bg-indigo-500/20 transition-colors"
            @click="emit('retryRun', run.id)"
          >
            <span class="i-carbon-restart w-3.5 h-3.5" />
            重试
          </button>
          <button
            v-if="run.status === 'completed'"
            class="px-2.5 py-1 text-[11px] font-medium rounded-md bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20 transition-colors"
            @click="showRejectDialog = true"
          >
            拒绝
          </button>
          <button
            v-if="run.status === 'running'"
            class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-red-500 text-white hover:bg-red-600 active:bg-red-700 shadow-sm transition-colors"
            @click="emit('cancel', run.id)"
          >
            <span class="i-carbon-stop-filled w-3.5 h-3.5" />
            取消运行
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div class="text-gray-400">创建时间</div>
        <div>{{ formatTime(run.created_at) }}</div>
        <div class="text-gray-400">完成时间</div>
        <div>{{ formatTime(run.completed_at) }}</div>
      </div>

      <!-- Leader decision -->
      <div v-if="leaderDecision" class="mt-3 p-3 rounded-lg bg-gray-50 dark:bg-white/3">
        <div class="flex items-center justify-between mb-1.5">
          <div class="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
            Leader 决策
          </div>
          <button
            class="text-[10px] px-1.5 py-0.5 rounded transition-colors"
            :class="showLeaderOutput
              ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400'
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/5 dark:text-gray-400 dark:hover:bg-white/10'"
            @click="showLeaderOutput = !showLeaderOutput"
          >
            {{ showLeaderOutput ? '收起对话' : '查看对话' }}
          </button>
        </div>
        <div class="text-xs text-gray-600 dark:text-gray-300">
          {{ leaderDecision.reason }}
        </div>
      </div>

      <!-- Leader agent output -->
      <div v-if="showLeaderOutput" class="mt-2">
        <OrchestratorAgentOutput
          :run-id="run.id"
          label="Leader 对话"
          :active="showLeaderOutput"
        />
      </div>

      <!-- Reject feedback -->
      <div
        v-if="run.reject_feedback"
        class="mt-3 p-3 rounded-lg bg-red-50/50 dark:bg-red-500/5 border border-red-100 dark:border-red-500/10"
      >
        <div class="text-[11px] font-semibold text-red-400 uppercase tracking-widest mb-1.5">
          拒绝反馈
        </div>
        <div class="text-xs text-red-600 dark:text-red-400">
          {{ run.reject_feedback }}
        </div>
      </div>
    </div>

    <!-- Assignments -->
    <div class="px-5 py-4">
      <div class="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-3">
        任务分配 ({{ assignments.length }})
      </div>

      <div v-if="assignments.length === 0" class="text-xs text-gray-400 text-center py-6">
        暂无任务分配
      </div>

      <div class="space-y-2.5">
        <div
          v-for="a in assignments"
          :key="a.id"
          class="p-3 rounded-lg border border-gray-200/60 dark:border-white/5 bg-white dark:bg-white/2"
        >
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <div
                :class="[assignmentStatusBadge[a.status]?.icon ?? 'i-carbon-help', assignmentStatusBadge[a.status]?.class ?? 'text-gray-400']"
                class="w-3.5 h-3.5"
              />
              <span class="text-[13px] font-medium">{{ a.title }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400">
                {{ a.role }}
              </span>
              <button
                v-if="a.status === 'failed'"
                class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-400 dark:hover:bg-indigo-500/20 transition-colors"
                @click="emit('retry', a.id)"
              >
                重试
              </button>
            </div>
          </div>

          <p class="text-xs text-gray-500 dark:text-gray-400 mb-2 line-clamp-2">
            {{ a.description }}
          </p>

          <div class="flex items-center justify-between text-[11px] text-gray-400">
            <div class="flex items-center gap-3">
              <span v-if="a.agent_provider">
                {{ a.agent_provider }}{{ a.agent_model ? ` / ${a.agent_model}` : '' }}
              </span>
              <span v-if="a.branch_name" class="font-mono">
                {{ a.branch_name }}
              </span>
            </div>
            <button
              v-if="a.status === 'running' || a.status === 'completed' || a.status === 'failed'"
              class="text-[10px] px-1.5 py-0.5 rounded transition-colors"
              :class="expandedAssignments.has(a.id)
                ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/5 dark:text-gray-400 dark:hover:bg-white/10'"
              @click="toggleAssignmentOutput(a.id)"
            >
              {{ expandedAssignments.has(a.id) ? '收起对话' : '查看对话' }}
            </button>
          </div>

          <div
            v-if="a.error_message"
            class="mt-2 p-2 rounded bg-red-50 dark:bg-red-500/5 text-[11px] text-red-600 dark:text-red-400 font-mono break-all"
          >
            {{ a.error_message }}
          </div>

          <!-- Worker agent output -->
          <div v-if="expandedAssignments.has(a.id)" class="mt-2">
            <OrchestratorAgentOutput
              :run-id="run.id"
              :assignment-id="a.id"
              :label="`${a.role} 对话`"
              :active="expandedAssignments.has(a.id)"
            />
          </div>
        </div>
      </div>
    </div>

    <OrchestratorRejectDialog
      v-if="showRejectDialog"
      @confirm="handleReject"
      @cancel="showRejectDialog = false"
    />
  </div>
</template>
