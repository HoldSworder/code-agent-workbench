<script setup lang="ts">
import { ref } from 'vue'

interface MockTask {
  id: string
  repoName: string
  phase: string
  phaseStatus: string
}

interface MockRequirement {
  id: string
  title: string
  description: string
  source: string
  status: string
  createdAt: string
  tasks: MockTask[]
}

const mockRequirements: MockRequirement[] = [
  {
    id: 'req-1',
    title: '用户登录流程重构',
    description: '重构现有登录逻辑，支持 OAuth2 和手机号验证码登录',
    source: 'feishu',
    status: 'in_progress',
    createdAt: '2025-04-01T10:00:00Z',
    tasks: [
      { id: 't1', repoName: 'frontend-app', phase: 't1-dev', phaseStatus: 'running' },
      { id: 't2', repoName: 'backend-api', phase: 'review', phaseStatus: 'waiting_confirm' },
    ],
  },
  {
    id: 'req-2',
    title: '数据导出功能',
    description: '支持 CSV / Excel 格式的批量数据导出',
    source: 'gitlab',
    status: 'in_progress',
    createdAt: '2025-04-02T08:30:00Z',
    tasks: [
      { id: 't3', repoName: 'backend-api', phase: 'plan', phaseStatus: 'waiting_confirm' },
    ],
  },
  {
    id: 'req-3',
    title: '权限管理模块',
    description: 'RBAC 权限控制，支持角色、菜单、按钮级别权限',
    source: 'manual',
    status: 'pending',
    createdAt: '2025-04-03T14:00:00Z',
    tasks: [],
  },
  {
    id: 'req-4',
    title: '日志监控看板',
    description: '集成 ELK 日志系统，提供实时日志查询和告警面板',
    source: 'feishu',
    status: 'done',
    createdAt: '2025-03-28T09:00:00Z',
    tasks: [
      { id: 't4', repoName: 'frontend-app', phase: 'mr', phaseStatus: 'done' },
      { id: 't5', repoName: 'backend-api', phase: 'mr', phaseStatus: 'done' },
    ],
  },
]

const sourceBadge: Record<string, { label: string, class: string }> = {
  feishu: { label: '飞书', class: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
  gitlab: { label: 'GitLab', class: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300' },
  manual: { label: '手动', class: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}

const statusBadge: Record<string, { label: string, class: string }> = {
  pending: { label: '待处理', class: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  in_progress: { label: '进行中', class: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300' },
  done: { label: '已完成', class: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
}

const phaseLabels: Record<string, string> = {
  design: '设计',
  plan: '计划',
  't1-dev': '开发',
  review: '评审',
  verify: '验证',
  mr: '合并',
}

function phaseStatusClass(status: string) {
  if (status === 'waiting_confirm')
    return 'text-amber-600 dark:text-amber-400'
  if (status === 'running')
    return 'text-indigo-600 dark:text-indigo-400'
  if (status === 'done')
    return 'text-green-600 dark:text-green-400'
  return 'text-gray-500'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const showDialog = ref(false)
const newReq = ref({ title: '', description: '', source: 'manual' })

function submitRequirement() {
  showDialog.value = false
  newReq.value = { title: '', description: '', source: 'manual' }
}
</script>

<template>
  <div class="p-6 max-w-5xl mx-auto">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">总看板</h1>
        <p class="text-sm text-gray-500 mt-1">所有需求及其关联任务的进度概览</p>
      </div>
      <button
        class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        @click="showDialog = true"
      >
        <div class="i-carbon-add w-4 h-4" />
        新建需求
      </button>
    </div>

    <div class="space-y-4">
      <div
        v-for="req in mockRequirements"
        :key="req.id"
        class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 transition-shadow hover:shadow-md"
      >
        <div class="flex items-start justify-between mb-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="text-base font-semibold truncate">{{ req.title }}</h3>
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium shrink-0"
                :class="sourceBadge[req.source]?.class"
              >
                {{ sourceBadge[req.source]?.label }}
              </span>
              <span
                class="px-2 py-0.5 rounded-full text-xs font-medium shrink-0"
                :class="statusBadge[req.status]?.class"
              >
                {{ statusBadge[req.status]?.label }}
              </span>
            </div>
            <p class="text-sm text-gray-500 dark:text-gray-400 line-clamp-1">{{ req.description }}</p>
          </div>
          <span class="text-xs text-gray-400 shrink-0 ml-4">{{ formatDate(req.createdAt) }}</span>
        </div>

        <div v-if="req.tasks.length > 0" class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <div
            v-for="task in req.tasks"
            :key="task.id"
            class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
            :class="task.phaseStatus === 'waiting_confirm'
              ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'"
          >
            <div class="i-carbon-folder-details w-3.5 h-3.5 text-gray-400" />
            <span class="text-gray-700 dark:text-gray-300">{{ task.repoName }}</span>
            <span class="text-gray-400">·</span>
            <span :class="phaseStatusClass(task.phaseStatus)">
              {{ phaseLabels[task.phase] || task.phase }}
            </span>
            <div
              v-if="task.phaseStatus === 'waiting_confirm'"
              class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"
            />
          </div>
        </div>
        <div v-else class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
          <span class="text-xs text-gray-400">暂无关联任务</span>
        </div>
      </div>
    </div>

    <!-- New Requirement Dialog -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-200"
        leave-active-class="transition-opacity duration-150"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="showDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="showDialog = false">
          <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xl w-full max-w-md p-6">
            <h2 class="text-lg font-semibold mb-4">新建需求</h2>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">标题</label>
                <input
                  v-model="newReq.title"
                  type="text"
                  placeholder="输入需求标题"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">描述</label>
                <textarea
                  v-model="newReq.description"
                  rows="3"
                  placeholder="输入需求描述"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                />
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">来源</label>
                <select
                  v-model="newReq.source"
                  class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="manual">手动</option>
                  <option value="feishu">飞书</option>
                  <option value="gitlab">GitLab</option>
                </select>
              </div>
            </div>
            <div class="flex justify-end gap-2 mt-6">
              <button
                class="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                @click="showDialog = false"
              >
                取消
              </button>
              <button
                class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
                @click="submitRequirement"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
