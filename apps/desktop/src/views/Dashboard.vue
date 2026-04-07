<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRequirementsStore } from '../stores/requirements'
import { useReposStore } from '../stores/repos'
import { useTasksStore } from '../stores/tasks'
import { rpc } from '../composables/use-sidecar'
import type { RepoTask } from '../stores/tasks'

interface ReqPhase { id: string, name: string, optional?: boolean, skippable?: boolean }
interface WorkflowPhase { id: string, name: string }
interface WorkflowStage { id: string, name: string, phases: WorkflowPhase[] }

const requirementsStore = useRequirementsStore()
const reposStore = useReposStore()
const tasksStore = useTasksStore()

const taskMap = ref<Record<string, (RepoTask & { repoName: string })[]>>({})

const requirementPhases = ref<ReqPhase[]>([])
const workflowStages = ref<WorkflowStage[]>([])
const phaseNameMap = computed(() =>
  Object.fromEntries(requirementPhases.value.map(p => [p.id, p.name])),
)
const allPhaseNameMap = computed(() => {
  const map: Record<string, string> = { ...phaseNameMap.value }
  for (const s of workflowStages.value) {
    for (const p of s.phases)
      map[p.id] = p.name
  }
  return map
})

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
  rpc<{ phases: ReqPhase[] }>('workflow.requirementPhases').then((res) => {
    if (res?.phases)
      requirementPhases.value = res.phases
  })
  rpc<{ stages: WorkflowStage[] }>('workflow.phases').then((res) => {
    if (res?.stages)
      workflowStages.value = res.stages
  })
  await Promise.all([requirementsStore.fetchAll(), reposStore.fetchAll(), loadMcpData()])
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
type CreateMode = 'manual' | 'feishu'
const createMode = ref<CreateMode>('manual')
const manualDescription = ref('')
const feishuUrl = ref('')
const feishuParsed = ref<{ projectKey: string, workItemType: string, workItemId: string } | null>(null)
const feishuError = ref('')

function parseFeishuUrl(url: string) {
  feishuError.value = ''
  feishuParsed.value = null
  if (!url.trim()) return

  const match = url.match(/project\.feishu\.cn\/([^/]+)\/(story|issue|defect|epic|task|requirement)\/detail\/(\d+)/)
  if (match) {
    feishuParsed.value = { projectKey: match[1], workItemType: match[2], workItemId: match[3] }
    return
  }

  const altMatch = url.match(/feishu\.cn\/project\/[^/]+\/([^/]+)\/(story|issue|defect|epic|task|requirement)\/detail\/(\d+)/)
  if (altMatch) {
    feishuParsed.value = { projectKey: altMatch[1], workItemType: altMatch[2], workItemId: altMatch[3] }
    return
  }

  feishuError.value = '无法识别的飞书项目链接格式'
}

const createMcpSelectedIds = ref<Set<string>>(new Set())

function preselectFeishuMcp() {
  const ids = mcpServers.value
    .filter(s => /feishu|飞书/i.test(s.name) || /feishu|飞书/i.test(s.description))
    .map(s => s.id)
  createMcpSelectedIds.value = new Set(ids)
}

function switchToFeishu() {
  createMode.value = 'feishu'
  preselectFeishuMcp()
}

function toggleCreateMcp(serverId: string) {
  const next = new Set(createMcpSelectedIds.value)
  if (next.has(serverId)) next.delete(serverId)
  else next.add(serverId)
  createMcpSelectedIds.value = next
}

function resetCreateDialog() {
  createMode.value = 'manual'
  manualDescription.value = ''
  feishuUrl.value = ''
  feishuParsed.value = null
  feishuError.value = ''
  createMcpSelectedIds.value = new Set()
}

const canSubmit = computed(() => {
  if (createMode.value === 'manual')
    return manualDescription.value.trim().length > 0
  return feishuParsed.value !== null
})

async function submitRequirement() {
  if (!canSubmit.value) return

  if (createMode.value === 'manual') {
    await requirementsStore.create({
      description: manualDescription.value.trim(),
      source: 'manual',
    })
  }
  else {
    await requirementsStore.create({
      description: feishuParsed.value
        ? `飞书项目 ${feishuParsed.value.projectKey} #${feishuParsed.value.workItemId} (${feishuParsed.value.workItemType})`
        : '',
      source: 'feishu',
      source_url: feishuUrl.value.trim(),
    })

    if (createMcpSelectedIds.value.size > 0) {
      const firstPhase = requirementPhases.value.find(p => !p.optional)
      if (firstPhase) {
        await rpc('mcp.setBindings', {
          stageId: '_requirements',
          phaseId: firstPhase.id,
          mcpServerIds: [...createMcpSelectedIds.value],
        })
        await loadMcpData()
      }
    }
  }

  showDialog.value = false
  resetCreateDialog()
  await refreshTaskMap()
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

async function startReqCollection(reqId: string) {
  const tasks = taskMap.value[reqId] ?? []
  if (!tasks.length)
    return
  const firstPhase = requirementPhases.value.find(p => !p.optional)
  if (!firstPhase)
    return
  for (const task of tasks) {
    await rpc('workflow.executeRequirementPhase', {
      repoTaskId: task.id,
      phaseId: firstPhase.id,
    })
  }
  await refreshTaskMap()
}

// ── 需求收集 MCP 选择弹窗 ──

interface McpServer {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  enabled: number
}

interface McpBinding {
  id: string
  stage_id: string
  phase_id: string
  mcp_server_id: string
}

const mcpServers = ref<McpServer[]>([])
const mcpBindings = ref<McpBinding[]>([])
const showMcpPicker = ref(false)
const mcpPickerReqId = ref('')
const selectedMcpIds = ref<Set<string>>(new Set())
const startingCollection = ref(false)

async function loadMcpData() {
  try {
    const [srvRes, bindRes] = await Promise.all([
      rpc<McpServer[]>('mcp.list'),
      rpc<McpBinding[]>('mcp.getAllBindings'),
    ])
    mcpServers.value = (srvRes ?? []).filter(s => s.enabled)
    mcpBindings.value = bindRes ?? []
  } catch {
    mcpServers.value = []
    mcpBindings.value = []
  }
}

function openMcpPicker(reqId: string) {
  mcpPickerReqId.value = reqId
  const firstPhase = requirementPhases.value.find(p => !p.optional)
  if (!firstPhase) return

  const existing = mcpBindings.value
    .filter(b => b.stage_id === '_requirements' && b.phase_id === firstPhase.id)
    .map(b => b.mcp_server_id)
  selectedMcpIds.value = new Set(existing)
  showMcpPicker.value = true
}

function toggleMcpSelection(serverId: string) {
  const next = new Set(selectedMcpIds.value)
  if (next.has(serverId)) next.delete(serverId)
  else next.add(serverId)
  selectedMcpIds.value = next
}

async function confirmStartCollection() {
  const reqId = mcpPickerReqId.value
  const tasks = taskMap.value[reqId] ?? []
  if (!tasks.length) return

  const firstPhase = requirementPhases.value.find(p => !p.optional)
  if (!firstPhase) return

  startingCollection.value = true
  try {
    await rpc('mcp.setBindings', {
      stageId: '_requirements',
      phaseId: firstPhase.id,
      mcpServerIds: [...selectedMcpIds.value],
    })

    for (const task of tasks) {
      await rpc('workflow.executeRequirementPhase', {
        repoTaskId: task.id,
        phaseId: firstPhase.id,
      })
    }
    showMcpPicker.value = false
    await refreshTaskMap()
    await loadMcpData()
  } catch (err) {
    console.error('Failed to start requirement collection:', err)
  } finally {
    startingCollection.value = false
  }
}

// ── 删除需求 ──
const pendingDeleteId = ref<string | null>(null)
const deleting = ref(false)

async function confirmDelete(reqId: string) {
  pendingDeleteId.value = reqId
}

async function executeDelete() {
  const id = pendingDeleteId.value
  if (!id) return
  deleting.value = true
  try {
    await requirementsStore.remove(id)
    delete taskMap.value[id]
  }
  finally {
    deleting.value = false
    pendingDeleteId.value = null
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
        <h1 class="text-xl font-semibold tracking-tight">需求看板</h1>
        <p class="text-[13px] text-gray-400 mt-1">管理需求并通过 AI 辅助收集与完善需求内容</p>
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
              <p v-if="req.description && req.description !== req.title" class="text-[13px] text-gray-400 line-clamp-1">{{ req.description }}</p>
              <!-- 飞书关联链接 -->
              <div v-if="req.source === 'feishu'" class="flex items-center gap-3 mt-1.5">
                <a
                  v-if="req.source_url"
                  :href="req.source_url"
                  target="_blank"
                  class="inline-flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                  @click.stop
                >
                  <div class="i-carbon-launch w-3 h-3" />
                  飞书项目
                </a>
                <a
                  v-if="req.doc_url"
                  :href="req.doc_url"
                  target="_blank"
                  class="inline-flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                  @click.stop
                >
                  <div class="i-carbon-document w-3 h-3" />
                  需求文档
                </a>
              </div>
            </div>
            <div class="shrink-0 ml-4 flex flex-col items-end gap-2">
              <div class="flex items-center gap-2">
                <span class="text-[11px] text-gray-400 tabular-nums">{{ formatDate(req.created_at) }}</span>
                <button
                  class="p-1 rounded-md text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  title="删除需求"
                  @click.stop="confirmDelete(req.id)"
                >
                  <div class="i-carbon-trash-can w-3.5 h-3.5" />
                </button>
              </div>
              <button
                v-if="req.source === 'feishu' && req.status === 'draft' && (taskMap[req.id] ?? []).length > 0"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-[12px] font-medium hover:bg-violet-500 shadow-sm shadow-violet-600/20 transition-all duration-150 active:scale-[0.97]"
                @click="mcpServers.length > 0 ? openMcpPicker(req.id) : startReqCollection(req.id)"
              >
                <div class="i-carbon-ai-status w-3.5 h-3.5" />
                获取飞书需求
              </button>
            </div>
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
                    {{ allPhaseNameMap[task.current_phase] ?? task.current_phase }}
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
        <div v-if="showDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="showDialog = false; resetCreateDialog()">
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-md p-6">
              <!-- 模式切换 -->
              <div class="flex items-center gap-1 p-1 rounded-lg bg-gray-100 dark:bg-white/5 mb-5">
                <button
                  class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-all duration-150"
                  :class="createMode === 'manual'
                    ? 'bg-white dark:bg-[#3a3a3e] text-gray-800 dark:text-gray-100 shadow-sm'
                    : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
                  @click="createMode = 'manual'"
                >
                  <div class="i-carbon-edit w-3.5 h-3.5" />
                  手动输入
                </button>
                <button
                  class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-all duration-150"
                  :class="createMode === 'feishu'
                    ? 'bg-white dark:bg-[#3a3a3e] text-gray-800 dark:text-gray-100 shadow-sm'
                    : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
                  @click="switchToFeishu"
                >
                  <div class="i-carbon-link w-3.5 h-3.5" />
                  飞书项目
                </button>
              </div>

              <!-- 手动模式 -->
              <div v-if="createMode === 'manual'" class="space-y-1">
                <textarea
                  v-model="manualDescription"
                  rows="6"
                  placeholder="输入需求内容..."
                  class="w-full px-3 py-2.5 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] leading-relaxed border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors resize-none"
                />
              </div>

              <!-- 飞书项目模式 -->
              <div v-else class="space-y-4">
                <div>
                  <label class="block text-[12px] font-medium text-gray-400 dark:text-gray-500 mb-1.5">飞书项目链接</label>
                  <input
                    v-model="feishuUrl"
                    type="text"
                    placeholder="粘贴飞书项目工作项链接..."
                    class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors font-mono"
                    @input="parseFeishuUrl(feishuUrl)"
                  >
                </div>

                <!-- 解析结果 -->
                <div
                  v-if="feishuParsed"
                  class="px-3 py-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-500/5 border border-emerald-200 dark:border-emerald-500/15"
                >
                  <div class="flex items-center gap-2 mb-1.5">
                    <div class="i-carbon-checkmark-filled w-3.5 h-3.5 text-emerald-500" />
                    <span class="text-[12px] font-medium text-emerald-600 dark:text-emerald-400">链接解析成功</span>
                  </div>
                  <div class="grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <span class="text-gray-400">项目</span>
                      <p class="font-medium text-gray-700 dark:text-gray-200 font-mono">{{ feishuParsed.projectKey }}</p>
                    </div>
                    <div>
                      <span class="text-gray-400">类型</span>
                      <p class="font-medium text-gray-700 dark:text-gray-200">{{ feishuParsed.workItemType }}</p>
                    </div>
                    <div>
                      <span class="text-gray-400">ID</span>
                      <p class="font-medium text-gray-700 dark:text-gray-200 font-mono">#{{ feishuParsed.workItemId }}</p>
                    </div>
                  </div>
                  <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
                    创建后可通过工作流获取需求SPEC文档 / 需求文档 / 描述内容
                  </p>
                </div>

                <!-- 解析错误 -->
                <div
                  v-if="feishuError"
                  class="px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-500/5 border border-red-200 dark:border-red-500/15"
                >
                  <div class="flex items-center gap-2">
                    <div class="i-carbon-warning-alt w-3.5 h-3.5 text-red-500" />
                    <span class="text-[12px] text-red-600 dark:text-red-400">{{ feishuError }}</span>
                  </div>
                  <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
                    支持格式：https://project.feishu.cn/{project}/story/detail/{id}
                  </p>
                </div>

                <!-- 按需 MCP 选择器 -->
                <div v-if="mcpServers.length > 0">
                  <label class="block text-[12px] font-medium text-gray-400 dark:text-gray-500 mb-1.5">
                    按需加载 MCP
                    <span class="font-normal text-gray-300 dark:text-gray-600 ml-1">（可选）</span>
                  </label>
                  <div class="space-y-1 max-h-36 overflow-y-auto">
                    <label
                      v-for="srv in mcpServers"
                      :key="srv.id"
                      class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors"
                      :class="createMcpSelectedIds.has(srv.id)
                        ? 'bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20'
                        : 'bg-gray-50 dark:bg-white/3 border border-gray-100 dark:border-white/5 hover:border-violet-200 dark:hover:border-violet-500/20'"
                      @click.prevent="toggleCreateMcp(srv.id)"
                    >
                      <input
                        type="checkbox"
                        :checked="createMcpSelectedIds.has(srv.id)"
                        class="w-3.5 h-3.5 rounded border-gray-300 text-violet-600 focus:ring-violet-500/20 cursor-pointer"
                      >
                      <div class="flex-1 min-w-0">
                        <div class="text-[12px] font-medium text-gray-700 dark:text-gray-200">{{ srv.name }}</div>
                        <div v-if="srv.description" class="text-[10px] text-gray-400 truncate">{{ srv.description }}</div>
                      </div>
                    </label>
                  </div>
                  <p class="text-[10px] text-gray-300 dark:text-gray-600 mt-1.5">
                    选中的 MCP 将在需求收集阶段自动注入到 Agent 运行环境
                  </p>
                </div>
              </div>

              <div class="flex justify-end gap-2 mt-6">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="showDialog = false; resetCreateDialog()"
                >
                  取消
                </button>
                <button
                  class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="!canSubmit"
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

    <!-- ── 删除确认弹窗 ── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="pendingDeleteId" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="pendingDeleteId = null">
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-sm p-6">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-10 h-10 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
                  <div class="i-carbon-warning-alt w-5 h-5 text-red-500" />
                </div>
                <div>
                  <h2 class="text-base font-semibold">删除需求</h2>
                  <p class="text-[13px] text-gray-400 mt-0.5">此操作不可撤销</p>
                </div>
              </div>
              <p class="text-[13px] text-gray-500 dark:text-gray-400 mb-1">
                确定要删除该需求吗？关联的所有流水线任务（包括 agent 运行记录、对话消息、提交快照）都将被一并删除。
              </p>
              <div
                v-if="(taskMap[pendingDeleteId] ?? []).length > 0"
                class="mt-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/5 border border-amber-200/60 dark:border-amber-500/10 text-[12px] text-amber-600 dark:text-amber-400"
              >
                该需求下有 {{ (taskMap[pendingDeleteId] ?? []).length }} 个关联任务将被删除
              </div>
              <div class="flex justify-end gap-2 mt-6">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  :disabled="deleting"
                  @click="pendingDeleteId = null"
                >
                  取消
                </button>
                <button
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white text-[13px] font-medium hover:bg-red-500 shadow-sm shadow-red-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
                  :disabled="deleting"
                  @click="executeDelete"
                >
                  <div v-if="deleting" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                  <div v-else class="i-carbon-trash-can w-4 h-4" />
                  {{ deleting ? '删除中...' : '确认删除' }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
    <!-- ── MCP 选择弹窗（需求收集前） ── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="showMcpPicker" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="showMcpPicker = false">
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-sm p-6">
              <div class="flex items-center gap-3 mb-4">
                <div class="w-9 h-9 rounded-full bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center shrink-0">
                  <div class="i-carbon-plug w-4 h-4 text-violet-500" />
                </div>
                <div>
                  <h2 class="text-[15px] font-semibold">选择按需 MCP</h2>
                  <p class="text-[12px] text-gray-400 mt-0.5">勾选需求收集阶段要启用的 MCP Server</p>
                </div>
              </div>

              <div class="space-y-1.5 mb-5">
                <label
                  v-for="srv in mcpServers"
                  :key="srv.id"
                  class="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
                  :class="selectedMcpIds.has(srv.id)
                    ? 'bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20'
                    : 'bg-gray-50 dark:bg-white/3 border border-gray-100 dark:border-white/5 hover:border-violet-200 dark:hover:border-violet-500/20'"
                  @click.prevent="toggleMcpSelection(srv.id)"
                >
                  <input
                    type="checkbox"
                    :checked="selectedMcpIds.has(srv.id)"
                    class="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500/20 cursor-pointer"
                  >
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-medium text-gray-800 dark:text-gray-100">{{ srv.name }}</div>
                    <div v-if="srv.description" class="text-[11px] text-gray-400 truncate">{{ srv.description }}</div>
                  </div>
                </label>
              </div>

              <div class="flex justify-end gap-2">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="showMcpPicker = false"
                >
                  取消
                </button>
                <button
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-[13px] font-medium hover:bg-violet-500 shadow-sm shadow-violet-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
                  :disabled="startingCollection"
                  @click="confirmStartCollection"
                >
                  <div v-if="startingCollection" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                  <div v-else class="i-carbon-ai-status w-4 h-4" />
                  {{ startingCollection ? '启动中…' : '开始需求收集' }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
