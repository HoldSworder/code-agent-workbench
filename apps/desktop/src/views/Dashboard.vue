<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRequirementsStore } from '../stores/requirements'
import { useReposStore } from '../stores/repos'
import { useTasksStore } from '../stores/tasks'
import { rpc } from '../composables/use-sidecar'
import type { RepoTask } from '../stores/tasks'

const requirementsStore = useRequirementsStore()
const reposStore = useReposStore()
const tasksStore = useTasksStore()

const taskMap = ref<Record<string, (RepoTask & { repoName: string })[]>>({})

const repoNameById = computed(() =>
  Object.fromEntries(reposStore.repos.map(r => [r.id, r.name])),
)

async function refreshTaskMap() {
  const entries = await Promise.all(
    requirementsStore.requirements.map(req =>
      rpc<RepoTask[]>('task.listByRequirement', { requirementId: req.id })
        .then(tasks => [req.id, tasks.map(t => ({ ...t, repoName: repoNameById.value[t.repo_id] ?? t.repo_id }))] as const)
        .catch(() => [req.id, []] as const),
    ),
  )
  taskMap.value = Object.fromEntries(entries)

  const allTasks = Object.values(taskMap.value).flat()
  await tasksStore.fetchErrorsForTasks(allTasks)
}

onMounted(async () => {
  await Promise.all([requirementsStore.fetchAll(), reposStore.fetchAll()])
  await refreshTaskMap()
})

const sourceBadge: Record<string, { label: string, class: string }> = {
  feishu: { label: '飞书', class: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' },
  gitlab: { label: 'GitLab', class: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400' },
  manual: { label: '手动', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
}

const statusBadge: Record<string, { label: string, class: string }> = {
  draft: { label: '草稿', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
  active: { label: '进行中', class: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400' },
  completed: { label: '已完成', class: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' },
  archived: { label: '已归档', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
}

const phaseLabels: Record<string, string> = {
  'design': '设计探索',
  'plan': '任务规划',
  't1-dev': 'T1 开发',
  'review': '代码审查',
  'verify': '验证',
  'mr': '创建 MR',
  'backend-spec-arrived': '后端联调',
  'test-spec-arrived': '测试 Spec',
  'e2e-verify': 'E2E 验证',
  'archive': '归档',
}

const phaseStatusLabels: Record<string, string> = {
  running: '运行中',
  waiting_confirm: '待确认',
  waiting_event: '等待事件',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function phaseStatusClass(status: string) {
  if (status === 'waiting_confirm')
    return 'text-amber-600 dark:text-amber-400'
  if (status === 'running')
    return 'text-indigo-600 dark:text-indigo-400'
  if (status === 'completed')
    return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'waiting_event')
    return 'text-blue-600 dark:text-blue-400'
  if (status === 'failed')
    return 'text-red-600 dark:text-red-400'
  return 'text-gray-500'
}

function formatDate(iso: string) {
  const normalized = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(normalized).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ── 新建需求弹窗 ──
const showDialog = ref(false)
const newReq = ref({ title: '', description: '', source: 'manual' })

async function submitRequirement() {
  if (!newReq.value.title)
    return
  await requirementsStore.create(newReq.value)
  showDialog.value = false
  newReq.value = { title: '', description: '', source: 'manual' }
}

// ── 分发到仓库弹窗 ──
const showDispatchDialog = ref(false)
const dispatchReqId = ref('')
const selectedRepoIds = ref<string[]>([])
const dispatching = ref(false)
const dispatchError = ref('')

function openDispatchDialog(reqId: string) {
  dispatchReqId.value = reqId
  selectedRepoIds.value = []
  dispatchError.value = ''
  showDispatchDialog.value = true
}

function toggleRepo(repoId: string) {
  const idx = selectedRepoIds.value.indexOf(repoId)
  if (idx === -1)
    selectedRepoIds.value.push(repoId)
  else
    selectedRepoIds.value.splice(idx, 1)
}

const dispatchedRepoIds = computed(() => {
  const tasks = taskMap.value[dispatchReqId.value] ?? []
  return new Set(tasks.map(t => t.repo_id))
})

async function dispatchAndStart() {
  if (!selectedRepoIds.value.length)
    return
  dispatching.value = true
  dispatchError.value = ''
  try {
    for (const repoId of selectedRepoIds.value) {
      const task = await tasksStore.createTask(dispatchReqId.value, repoId)
      await tasksStore.startWorkflow(task.id)
    }
    showDispatchDialog.value = false
    await refreshTaskMap()
  }
  catch (err: unknown) {
    dispatchError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    dispatching.value = false
  }
}

// ── 重试失败的任务 ──

async function retryTask(taskId: string) {
  try {
    await tasksStore.retry(taskId)
    await refreshTaskMap()

    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2000))
      await refreshTaskMap()
      const allTasks = Object.values(taskMap.value).flat()
      const task = allTasks.find(t => t.id === taskId)
      if (!task || task.phase_status !== 'running')
        break
    }
  }
  catch {
    // store.retry 内部已记录错误
  }
  finally {
    tasksStore.finishRetry(taskId)
    await refreshTaskMap()
  }
}
</script>

<template>
  <div class="p-8 max-w-5xl mx-auto">
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">总看板</h1>
        <p class="text-[13px] text-gray-400 mt-1">所有需求及其关联任务的进度概览</p>
      </div>
      <button
        class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
        @click="showDialog = true"
      >
        <div class="i-carbon-add w-4 h-4" />
        新建需求
      </button>
    </div>

    <div class="space-y-3">
      <template v-if="requirementsStore.requirements.length > 0">
        <div
          v-for="req in requirementsStore.requirements"
          :key="req.id"
          class="bg-white dark:bg-[#28282c] rounded-xl p-5 shadow-sm shadow-black/[0.04] dark:shadow-none transition-all duration-200 hover:shadow-md hover:shadow-black/[0.06]"
        >
          <div class="flex items-start justify-between mb-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1.5">
                <h3 class="text-[15px] font-semibold truncate">{{ req.title }}</h3>
                <span
                  class="px-2 py-0.5 rounded-md text-[11px] font-medium shrink-0"
                  :class="sourceBadge[req.source]?.class"
                >
                  {{ sourceBadge[req.source]?.label }}
                </span>
                <span
                  class="px-2 py-0.5 rounded-md text-[11px] font-medium shrink-0"
                  :class="statusBadge[req.status]?.class"
                >
                  {{ statusBadge[req.status]?.label }}
                </span>
              </div>
              <p class="text-[13px] text-gray-400 line-clamp-1">{{ req.description }}</p>
            </div>
            <span class="text-[11px] text-gray-400 shrink-0 ml-4 tabular-nums">{{ formatDate(req.created_at) }}</span>
          </div>

          <!-- 关联任务列表 -->
          <div v-if="(taskMap[req.id] ?? []).length > 0" class="mt-3 pt-3 border-t border-gray-100 dark:border-white/5">
            <div class="space-y-2">
              <div
                v-for="task in taskMap[req.id]"
                :key="task.id"
              >
                <div
                  class="flex items-center gap-2 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors"
                  :class="{
                    'bg-amber-50 dark:bg-amber-500/10': task.phase_status === 'waiting_confirm',
                    'bg-red-50 dark:bg-red-500/10': task.phase_status === 'failed',
                    'bg-gray-50 dark:bg-white/5': task.phase_status !== 'waiting_confirm' && task.phase_status !== 'failed',
                  }"
                >
                  <div class="i-carbon-folder-details w-3.5 h-3.5 text-gray-400 opacity-60" />
                  <span class="text-gray-600 dark:text-gray-300">{{ task.repoName }}</span>
                  <span class="text-gray-300 dark:text-gray-600">·</span>
                  <span :class="phaseStatusClass(task.phase_status)">
                    {{ phaseLabels[task.current_phase] || task.current_phase }}
                    ({{ phaseStatusLabels[task.phase_status] || task.phase_status }})
                  </span>
                  <div
                    v-if="task.phase_status === 'waiting_confirm'"
                    class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"
                  />
                  <button
                    v-if="task.phase_status === 'failed' || task.phase_status === 'cancelled'"
                    class="ml-1 flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-colors text-[11px]"
                    :disabled="tasksStore.retrying.has(task.id)"
                    @click.stop="retryTask(task.id)"
                  >
                    <div
                      class="w-3 h-3"
                      :class="tasksStore.retrying.has(task.id) ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-restart'"
                    />
                    {{ tasksStore.retrying.has(task.id) ? '重试中...' : '重试' }}
                  </button>
                </div>
                <div
                  v-if="tasksStore.taskErrors[task.id]"
                  class="mt-1 mx-1 px-2.5 py-1.5 rounded bg-red-50 dark:bg-red-500/5 text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all"
                >
                  {{ tasksStore.taskErrors[task.id] }}
                </div>
              </div>
            </div>

            <!-- 追加分发按钮 -->
            <button
              v-if="reposStore.repos.length > (taskMap[req.id] ?? []).length"
              class="mt-2 flex items-center gap-1 text-[12px] text-indigo-500 hover:text-indigo-600 transition-colors"
              @click="openDispatchDialog(req.id)"
            >
              <div class="i-carbon-add w-3.5 h-3.5" />
              分发到更多仓库
            </button>
          </div>

          <!-- 无关联任务 -->
          <div v-else class="mt-3 pt-3 border-t border-gray-100 dark:border-white/5 flex items-center justify-between">
            <span class="text-[12px] text-gray-300 dark:text-gray-600">暂无关联任务</span>
            <button
              v-if="reposStore.repos.length > 0"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[12px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
              @click="openDispatchDialog(req.id)"
            >
              <div class="i-carbon-deploy w-3.5 h-3.5" />
              分发到仓库
            </button>
            <span v-else class="text-[12px] text-gray-300 dark:text-gray-500">
              请先在设置中添加仓库
            </span>
          </div>
        </div>
      </template>

      <div v-else class="text-center py-20 text-gray-400">
        <div class="i-carbon-catalog w-10 h-10 mx-auto mb-3 opacity-30" />
        <p class="text-[13px]">暂无需求，点击右上角「新建需求」开始</p>
      </div>
    </div>

    <!-- ── 新建需求弹窗 ── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="showDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="showDialog = false">
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-md p-6">
              <h2 class="text-base font-semibold mb-5">新建需求</h2>
              <div class="space-y-4">
                <div>
                  <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">标题</label>
                  <input
                    v-model="newReq.title"
                    type="text"
                    placeholder="输入需求标题"
                    class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                  >
                </div>
                <div>
                  <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">描述</label>
                  <textarea
                    v-model="newReq.description"
                    rows="3"
                    placeholder="输入需求描述"
                    class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors resize-none"
                  />
                </div>
                <div>
                  <label class="block text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">来源</label>
                  <select
                    v-model="newReq.source"
                    class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors appearance-auto"
                  >
                    <option value="manual">手动</option>
                    <option value="feishu">飞书</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </div>
              </div>
              <div class="flex justify-end gap-2 mt-6">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="showDialog = false"
                >
                  取消
                </button>
                <button
                  class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
                  @click="submitRequirement"
                >
                  创建
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>

    <!-- ── 分发到仓库弹窗 ── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="showDispatchDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="showDispatchDialog = false">
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-md p-6">
              <h2 class="text-base font-semibold mb-1">分发到仓库</h2>
              <p class="text-[13px] text-gray-400 mb-5">
                选择要分发的仓库，将为每个仓库创建独立任务并启动工作流
              </p>

              <div class="space-y-2 max-h-64 overflow-y-auto">
                <label
                  v-for="repo in reposStore.repos"
                  :key="repo.id"
                  class="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
                  :class="[
                    selectedRepoIds.includes(repo.id)
                      ? 'bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/20'
                      : dispatchedRepoIds.has(repo.id)
                        ? 'bg-gray-50 dark:bg-white/3 border border-gray-100 dark:border-white/5 opacity-50 cursor-not-allowed'
                        : 'bg-gray-50 dark:bg-white/3 border border-gray-100 dark:border-white/5 hover:border-indigo-200 dark:hover:border-indigo-500/20',
                  ]"
                  @click.prevent="!dispatchedRepoIds.has(repo.id) && toggleRepo(repo.id)"
                >
                  <input
                    type="checkbox"
                    :checked="selectedRepoIds.includes(repo.id)"
                    :disabled="dispatchedRepoIds.has(repo.id)"
                    class="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer"
                  >
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ repo.name }}</div>
                    <div class="text-[11px] text-gray-400 truncate">{{ repo.local_path }}</div>
                  </div>
                  <span v-if="dispatchedRepoIds.has(repo.id)" class="text-[11px] text-emerald-500 font-medium">已分发</span>
                  <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded font-mono">{{ repo.default_branch }}</span>
                </label>
              </div>

              <div v-if="reposStore.repos.length === 0" class="text-center py-8 text-gray-400">
                <p class="text-[13px]">暂无仓库，请先在设置中添加</p>
              </div>

              <div v-if="dispatchError" class="mt-3 p-3 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                <p class="text-[12px] text-red-600 dark:text-red-400">{{ dispatchError }}</p>
              </div>

              <div class="flex justify-end gap-2 mt-6">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="showDispatchDialog = false"
                >
                  取消
                </button>
                <button
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="selectedRepoIds.length === 0 || dispatching"
                  @click="dispatchAndStart"
                >
                  <div v-if="dispatching" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                  <div v-else class="i-carbon-play-filled w-4 h-4" />
                  {{ dispatching ? '分发中...' : `分发并启动 (${selectedRepoIds.length})` }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
