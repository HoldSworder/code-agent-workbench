<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const repoId = route.params.id as string

const phases = [
  { id: 'design', label: '设计', icon: 'i-carbon-sketch' },
  { id: 'plan', label: '计划', icon: 'i-carbon-list-checked' },
  { id: 't1-dev', label: '开发', icon: 'i-carbon-code' },
  { id: 'review', label: '评审', icon: 'i-carbon-search' },
  { id: 'verify', label: '验证', icon: 'i-carbon-checkmark-outline' },
  { id: 'mr', label: '合并', icon: 'i-carbon-branch' },
]

interface MockKanbanTask {
  id: string
  requirementTitle: string
  branchName: string
  phase: string
  phaseStatus: string
  updatedAt: string
}

const mockTasks: MockKanbanTask[] = [
  { id: 't1', requirementTitle: '用户登录流程重构', branchName: 'feat/login-refactor', phase: 't1-dev', phaseStatus: 'running', updatedAt: '2025-04-03T10:30:00Z' },
  { id: 't2', requirementTitle: '数据导出功能', branchName: 'feat/data-export', phase: 'plan', phaseStatus: 'waiting_confirm', updatedAt: '2025-04-03T09:15:00Z' },
  { id: 't3', requirementTitle: '权限管理模块', branchName: 'feat/rbac', phase: 'design', phaseStatus: 'running', updatedAt: '2025-04-03T08:00:00Z' },
  { id: 't4', requirementTitle: '日志监控看板', branchName: 'feat/log-dashboard', phase: 'review', phaseStatus: 'waiting_confirm', updatedAt: '2025-04-02T18:00:00Z' },
  { id: 't5', requirementTitle: 'API 限流策略', branchName: 'feat/rate-limit', phase: 'verify', phaseStatus: 'running', updatedAt: '2025-04-02T14:00:00Z' },
  { id: 't6', requirementTitle: '缓存优化', branchName: 'feat/cache-opt', phase: 'mr', phaseStatus: 'done', updatedAt: '2025-04-01T16:00:00Z' },
]

function tasksForPhase(phaseId: string) {
  return mockTasks.filter(t => t.phase === phaseId)
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    running: '运行中',
    waiting_confirm: '待确认',
    done: '已完成',
    error: '错误',
  }
  return map[status] || status
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / 3600000)
  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function openTask(taskId: string) {
  router.push(`/repo/${repoId}/task/${taskId}`)
}
</script>

<template>
  <div class="p-6 h-full flex flex-col">
    <div class="mb-5">
      <h1 class="text-2xl font-bold tracking-tight">仓库流水线</h1>
      <p class="text-sm text-gray-500 mt-1">按阶段查看所有任务的执行进度</p>
    </div>

    <div class="flex-1 flex gap-4 overflow-x-auto pb-4">
      <div
        v-for="phase in phases"
        :key="phase.id"
        class="flex-shrink-0 w-64 flex flex-col"
      >
        <!-- Column header -->
        <div class="flex items-center gap-2 mb-3 px-1">
          <div :class="[phase.icon, 'w-4 h-4 text-gray-400']" />
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-300">{{ phase.label }}</span>
          <span class="ml-auto text-xs text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded-full">
            {{ tasksForPhase(phase.id).length }}
          </span>
        </div>

        <!-- Column body -->
        <div class="flex-1 bg-gray-100/60 dark:bg-gray-900/60 rounded-xl p-2 space-y-2 min-h-32">
          <div
            v-for="task in tasksForPhase(phase.id)"
            :key="task.id"
            class="bg-white dark:bg-gray-800 rounded-lg p-3 border transition-all cursor-pointer hover:shadow-md"
            :class="task.phaseStatus === 'waiting_confirm'
              ? 'border-amber-300 dark:border-amber-600 shadow-amber-100 dark:shadow-amber-900/20 animate-pulse-border'
              : 'border-gray-200 dark:border-gray-700'"
            @click="openTask(task.id)"
          >
            <p class="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1 truncate">
              {{ task.requirementTitle }}
            </p>
            <p class="text-xs text-gray-400 truncate mb-2">{{ task.branchName }}</p>
            <div class="flex items-center justify-between">
              <span
                class="text-xs font-medium px-2 py-0.5 rounded-full"
                :class="{
                  'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300': task.phaseStatus === 'waiting_confirm',
                  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300': task.phaseStatus === 'running',
                  'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300': task.phaseStatus === 'done',
                }"
              >
                {{ statusLabel(task.phaseStatus) }}
              </span>
              <span class="text-xs text-gray-400">{{ timeAgo(task.updatedAt) }}</span>
            </div>
          </div>

          <div
            v-if="tasksForPhase(phase.id).length === 0"
            class="flex items-center justify-center h-20 text-xs text-gray-400"
          >
            暂无任务
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
