<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTasksStore } from '../stores/tasks'
import { useRequirementsStore } from '../stores/requirements'

const route = useRoute()
const router = useRouter()

const repoId = route.params.id as string
const tasksStore = useTasksStore()
const requirementsStore = useRequirementsStore()

const phases = [
  { id: 'design', label: '设计探索', icon: 'i-carbon-sketch' },
  { id: 'plan', label: '任务规划', icon: 'i-carbon-list-checked' },
  { id: 't1-dev', label: 'T1 开发', icon: 'i-carbon-code' },
  { id: 'review', label: '代码审查', icon: 'i-carbon-search' },
  { id: 'verify', label: '验证', icon: 'i-carbon-checkmark-outline' },
  { id: 'mr', label: '创建 MR', icon: 'i-carbon-branch' },
  { id: 'backend-spec-arrived', label: '后端联调', icon: 'i-carbon-connect' },
  { id: 'test-spec-arrived', label: '测试 Spec', icon: 'i-carbon-task' },
  { id: 'e2e-verify', label: 'E2E 验证', icon: 'i-carbon-screen' },
  { id: 'archive', label: '归档', icon: 'i-carbon-archive' },
]

const requirementById = computed(() =>
  Object.fromEntries(requirementsStore.requirements.map(r => [r.id, r])),
)

interface KanbanTask {
  id: string
  requirementTitle: string
  branchName: string
  phase: string
  phaseStatus: string
  updatedAt: string
}

const kanbanTasks = computed<KanbanTask[]>(() =>
  tasksStore.tasks.map(t => ({
    id: t.id,
    requirementTitle: requirementById.value[t.requirement_id]?.title ?? t.requirement_id,
    branchName: t.branch_name,
    phase: t.current_phase,
    phaseStatus: t.phase_status,
    updatedAt: t.updated_at,
  })),
)

onMounted(async () => {
  await requirementsStore.fetchAll()
  await tasksStore.fetchByRepo(repoId)
})

function tasksForPhase(phaseId: string) {
  return kanbanTasks.value.filter(t => t.phase === phaseId)
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    running: '运行中',
    waiting_confirm: '待确认',
    waiting_event: '等待事件',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return map[status] || status
}

function timeAgo(iso: string) {
  const normalized = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  const diff = Date.now() - new Date(normalized).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

function openTask(taskId: string) {
  router.push(`/repo/${repoId}/task/${taskId}`)
}

async function retryTask(taskId: string) {
  try {
    await tasksStore.retry(taskId)
    await tasksStore.fetchByRepo(repoId)

    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2000))
      await tasksStore.fetchByRepo(repoId)
      const task = tasksStore.tasks.find(t => t.id === taskId)
      if (!task || task.phase_status !== 'running')
        break
    }
  }
  catch {
    // store.retry 内部已记录错误
  }
  finally {
    tasksStore.finishRetry(taskId)
    await tasksStore.fetchByRepo(repoId)
  }
}
</script>

<template>
  <div class="p-8 h-full flex flex-col">
    <div class="mb-6">
      <h1 class="text-xl font-semibold tracking-tight">仓库流水线</h1>
      <p class="text-[13px] text-gray-400 mt-1">按阶段查看所有任务的执行进度</p>
    </div>

    <div class="flex-1 flex gap-3 overflow-x-auto pb-4">
      <div
        v-for="phase in phases"
        :key="phase.id"
        class="flex-shrink-0 w-60 flex flex-col"
      >
        <div class="flex items-center gap-2 mb-2.5 px-1">
          <div :class="[phase.icon, 'w-3.5 h-3.5 text-gray-400 opacity-60']" />
          <span class="text-[13px] font-semibold text-gray-600 dark:text-gray-300">{{ phase.label }}</span>
          <span class="ml-auto text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
            {{ tasksForPhase(phase.id).length }}
          </span>
        </div>

        <div class="flex-1 bg-white/40 dark:bg-white/[0.02] rounded-xl p-2 space-y-2 min-h-32">
          <div
            v-for="task in tasksForPhase(phase.id)"
            :key="task.id"
            class="bg-white dark:bg-[#28282c] rounded-lg p-3 shadow-sm shadow-black/[0.04] dark:shadow-none transition-all duration-150 cursor-pointer hover:shadow-md hover:shadow-black/[0.06]"
            @click="openTask(task.id)"
          >
            <p class="text-[13px] font-medium text-gray-800 dark:text-gray-100 mb-1 truncate">
              {{ task.requirementTitle }}
            </p>
            <p class="text-[11px] text-gray-400 font-mono truncate mb-2.5">{{ task.branchName }}</p>
            <div class="flex items-center justify-between">
              <span
                class="text-[11px] font-medium px-2 py-0.5 rounded-md"
                :class="{
                  'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400': task.phaseStatus === 'waiting_confirm',
                  'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400': task.phaseStatus === 'running',
                  'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400': task.phaseStatus === 'completed',
                  'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400': task.phaseStatus === 'waiting_event',
                  'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400': task.phaseStatus === 'failed',
                  'bg-gray-50 text-gray-500 dark:bg-white/5 dark:text-gray-500': task.phaseStatus === 'cancelled',
                }"
              >
                {{ statusLabel(task.phaseStatus) }}
              </span>
              <span class="text-[11px] text-gray-400 tabular-nums">{{ timeAgo(task.updatedAt) }}</span>
            </div>
            <button
              v-if="task.phaseStatus === 'failed' || task.phaseStatus === 'cancelled'"
              class="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-[11px] font-medium hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
              :disabled="tasksStore.retrying.has(task.id)"
              @click.stop="retryTask(task.id)"
            >
              <div
                class="w-3.5 h-3.5"
                :class="tasksStore.retrying.has(task.id) ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-restart'"
              />
              {{ tasksStore.retrying.has(task.id) ? '重试中...' : '重试当前阶段' }}
            </button>
            <div
              v-if="tasksStore.taskErrors[task.id]"
              class="mt-1.5 px-2 py-1.5 rounded bg-red-50 dark:bg-red-500/5 text-[10px] text-red-500 dark:text-red-400 leading-relaxed break-all"
            >
              {{ tasksStore.taskErrors[task.id] }}
            </div>
          </div>

          <div
            v-if="tasksForPhase(phase.id).length === 0"
            class="flex items-center justify-center h-20 text-[12px] text-gray-300 dark:text-gray-600"
          >
            暂无任务
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
