<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRequirementsStore } from '../stores/requirements'
import { useReposStore } from '../stores/repos'
import { useTasksStore } from '../stores/tasks'
import { useOrchestratorStore } from '../stores/orchestrator'
import { rpc } from '../composables/use-sidecar'
import type { RepoTask } from '../stores/tasks'

interface ReqPhase { id: string, name: string, optional?: boolean, skippable?: boolean }
interface WorkflowPhase { id: string, name: string }
interface WorkflowStage { id: string, name: string, phases: WorkflowPhase[] }
interface ReqSession { sessionId: string, filePath: string, provider: string, modifiedAt: string, sizeBytes: number, firstTurnPreview: string | null }
interface ToolCall { tool_use_id: string, name: string, input: Record<string, unknown>, result: string | null, is_error: boolean }
interface TranscriptBlock { kind: 'text' | 'thinking' | 'tool_use', text: string, tool_call: ToolCall | null }
interface TranscriptTurn { index: number, user_text: string, blocks: TranscriptBlock[], timestamp: string }

const requirementsStore = useRequirementsStore()
const reposStore = useReposStore()
const tasksStore = useTasksStore()
const orchestratorStore = useOrchestratorStore()

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
  await Promise.all([requirementsStore.fetchAll(), reposStore.fetchAll(), loadMcpData(), orchestratorStore.fetchStatus()])
  await refreshTaskMap()
})

const sourceBadge: Record<string, { label: string, class: string }> = {
  feishu: { label: '飞书', class: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' },
  gitlab: { label: 'GitLab', class: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400' },
  manual: { label: '手动', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
}

const statusBadge: Record<string, { label: string, class: string }> = {
  fetching: { label: '获取中', class: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400' },
  fetch_failed: { label: '获取失败', class: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' },
  pending: { label: '待编排', class: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' },
  draft: { label: '草稿', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
  active: { label: '进行中', class: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400' },
  suspended: { label: '已挂起', class: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400' },
  completed: { label: '已完成', class: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' },
  archived: { label: '已归档', class: 'bg-gray-100 text-gray-500 dark:bg-gray-500/10 dark:text-gray-400' },
}

const statusGroupOrder = [
  { key: 'fetching', icon: 'i-carbon-ai-status', dot: 'bg-violet-500' },
  { key: 'pending', icon: 'i-carbon-pending', dot: 'bg-blue-500' },
  { key: 'draft', icon: 'i-carbon-document-blank', dot: 'bg-gray-400' },
  { key: 'active', icon: 'i-carbon-in-progress', dot: 'bg-indigo-500' },
  { key: 'suspended', icon: 'i-carbon-pause-outline', dot: 'bg-amber-500' },
  { key: 'completed', icon: 'i-carbon-checkmark-outline', dot: 'bg-emerald-500' },
  { key: 'archived', icon: 'i-carbon-archive', dot: 'bg-gray-300 dark:bg-gray-600' },
]

function parseTimestamp(raw: string): number {
  const normalized = raw.includes('T') || raw.includes('Z') ? raw : `${raw.replace(' ', 'T')}Z`
  return new Date(normalized).getTime()
}

function getReqSortTime(reqId: string, createdAt: string): number {
  const tasks = taskMap.value[reqId] ?? []
  if (!tasks.length) return parseTimestamp(createdAt)
  return Math.max(...tasks.map(t => parseTimestamp(t.updated_at)))
}

function deriveEffectiveStatus(req: { id: string, status: string }): string {
  if (req.status === 'fetching' || req.status === 'fetch_failed')
    return req.status

  const tasks = taskMap.value[req.id] ?? []
  if (tasks.length === 0) return req.status

  const statuses = tasks.map(t => t.phase_status)

  const ACTIVE_STATES = ['running', 'waiting_input', 'waiting_confirm', 'waiting_event']
  if (statuses.some(s => ACTIVE_STATES.includes(s)))
    return 'active'
  if (statuses.some(s => s === 'failed' || s === 'cancelled'))
    return 'active'
  if (statuses.every(s => s === 'completed'))
    return 'completed'
  if (statuses.every(s => s === 'suspended' || s === 'completed'))
    return 'suspended'
  if (statuses.every(s => s === 'pending'))
    return 'draft'

  return req.status
}

const groupedRequirements = computed(() => {
  const map = new Map<string, typeof requirementsStore.requirements>()
  for (const req of requirementsStore.requirements) {
    const effectiveStatus = deriveEffectiveStatus(req)
    const list = map.get(effectiveStatus) ?? []
    list.push(req)
    map.set(effectiveStatus, list)
  }
  return statusGroupOrder.map(g => ({
    ...g,
    label: statusBadge[g.key]?.label ?? g.key,
    badgeClass: statusBadge[g.key]?.class ?? '',
    items: (map.get(g.key) ?? []).slice().sort(
      (a, b) => getReqSortTime(b.id, b.created_at) - getReqSortTime(a.id, a.created_at),
    ),
  }))
})

const phaseStatusLabels: Record<string, string> = {
  pending: '待启动',
  running: '运行中',
  waiting_input: '待反馈',
  waiting_confirm: '待确认',
  waiting_event: '等待事件',
  suspended: '已挂起',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function phaseStatusClass(status: string) {
  if (status === 'pending')
    return 'text-gray-500 dark:text-gray-400'
  if (status === 'waiting_input')
    return 'text-orange-600 dark:text-orange-400'
  if (status === 'waiting_confirm')
    return 'text-amber-600 dark:text-amber-400'
  if (status === 'running')
    return 'text-indigo-600 dark:text-indigo-400'
  if (status === 'completed')
    return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'waiting_event')
    return 'text-blue-600 dark:text-blue-400'
  if (status === 'suspended')
    return 'text-gray-500 dark:text-gray-400'
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
const requirementMode = ref<'workflow' | 'orchestrator'>('workflow')
const manualTitle = ref('')
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
  requirementMode.value = 'workflow'
  manualTitle.value = ''
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
      title: manualTitle.value.trim() || undefined,
      description: manualDescription.value.trim(),
      source: 'manual',
      mode: requirementMode.value,
    })
  }
  else {
    const req = await requirementsStore.create({
      description: feishuParsed.value
        ? `飞书项目 ${feishuParsed.value.projectKey} #${feishuParsed.value.workItemId} (${feishuParsed.value.workItemType})`
        : '',
      source: 'feishu',
      source_url: feishuUrl.value.trim(),
      mode: requirementMode.value,
    })

    const mcpIds = [...createMcpSelectedIds.value]

    if (mcpIds.length > 0) {
      const firstPhase = requirementPhases.value.find(p => !p.optional)
      if (firstPhase) {
        await rpc('mcp.setBindings', {
          stageId: '_requirements',
          phaseId: firstPhase.id,
          mcpServerIds: mcpIds,
        })
        await loadMcpData()
      }
    }

    await rpc('requirement.startFetch', {
      requirementId: req.id,
      mcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
    })
    await requirementsStore.refreshOne(req.id)
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

async function dispatchToRepos() {
  if (!selectedRepoIds.value.length)
    return
  dispatching.value = true
  dispatchError.value = ''
  try {
    for (const repoId of selectedRepoIds.value) {
      await tasksStore.createTask(dispatchReqId.value, repoId)
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

async function retryRequirementFetch(reqId: string) {
  const bindings = mcpBindings.value.filter(b => b.stage_id === '_requirements')
  const mcpIds = bindings.map(b => b.mcp_server_id)
  await rpc('requirement.retryFetch', {
    requirementId: reqId,
    mcpServerIds: mcpIds.length > 0 ? mcpIds : undefined,
  })
  await requirementsStore.refreshOne(reqId)
}

const orchestratorDispatching = ref(false)
async function dispatchToOrchestrator(reqId: string) {
  orchestratorDispatching.value = true
  try {
    await requirementsStore.updateMode(reqId, 'orchestrator')
    if (!orchestratorStore.status?.running)
      await orchestratorStore.start()
    await requirementsStore.refreshOne(reqId)
  }
  finally {
    orchestratorDispatching.value = false
  }
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

// ── 需求详情面板 ──
const selectedReqId = ref<string | null>(null)

const selectedReq = computed(() =>
  requirementsStore.requirements.find(r => r.id === selectedReqId.value),
)

const selectedReqTasks = computed(() =>
  selectedReqId.value ? (taskMap.value[selectedReqId.value] ?? []) : [],
)

function openReqDetail(reqId: string) {
  selectedReqId.value = reqId
}

// ── 需求获取实时输出 ──
const reqLiveOutput = ref('')
let reqPollTimer: ReturnType<typeof setInterval> | null = null

function stopReqOutputPoll() {
  if (reqPollTimer) { clearInterval(reqPollTimer); reqPollTimer = null }
}

function startReqOutputPoll(reqId: string) {
  stopReqOutputPoll()
  reqPollTimer = setInterval(async () => {
    try {
      const { output } = await rpc<{ output: string }>('requirement.getLiveOutput', { requirementId: reqId })
      reqLiveOutput.value = output
    }
    catch {}
    await requirementsStore.refreshOne(reqId)
    const req = requirementsStore.requirements.find(r => r.id === reqId)
    if (!req || req.status !== 'fetching') {
      stopReqOutputPoll()
    }
  }, 1500)
}

watch(selectedReqId, (id) => {
  stopReqOutputPoll()
  reqLiveOutput.value = ''
  if (!id) return
  const req = requirementsStore.requirements.find(r => r.id === id)
  if (req?.status === 'fetching') startReqOutputPoll(id)
})

watch(() => requirementsStore.requirements.find(r => r.id === selectedReqId.value)?.status, (newStatus, oldStatus) => {
  if (!selectedReqId.value) return
  if (newStatus === 'fetching' && oldStatus !== 'fetching') {
    startReqOutputPoll(selectedReqId.value)
  }
})

onUnmounted(() => stopReqOutputPoll())

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

// ── 会话详情弹窗 ──
const showReqSessionModal = ref(false)
const reqSessionModalReqId = ref<string | null>(null)
const reqSessionModalSessions = ref<ReqSession[]>([])
const reqSessionModalLoading = ref(false)
const reqSessionModalTranscript = ref<TranscriptTurn[]>([])
const reqSessionModalTranscriptLoading = ref(false)
const reqSessionModalSelectedId = ref<string | null>(null)
const reqSessionModalFilePath = ref<string | null>(null)
const reqSessionExpandedBlocks = ref(new Set<string>())

async function openReqSessionModal(reqId: string) {
  reqSessionModalReqId.value = reqId
  reqSessionModalSessions.value = []
  reqSessionModalTranscript.value = []
  reqSessionModalSelectedId.value = null
  reqSessionModalFilePath.value = null
  showReqSessionModal.value = true
  reqSessionModalLoading.value = true
  try {
    const res = await rpc<{ items: ReqSession[] }>('requirement.listSessions', { requirementId: reqId })
    reqSessionModalSessions.value = res?.items ?? []
  }
  catch { reqSessionModalSessions.value = [] }
  finally { reqSessionModalLoading.value = false }
}

async function openReqSessionTranscript(session: ReqSession) {
  reqSessionModalSelectedId.value = session.sessionId
  reqSessionModalFilePath.value = session.filePath
  reqSessionModalTranscriptLoading.value = true
  reqSessionExpandedBlocks.value = new Set()
  try {
    const res = await rpc<{ turns: TranscriptTurn[], format: string, filePath: string | null }>('requirement.sessionTranscript', { sessionId: session.sessionId })
    reqSessionModalTranscript.value = res?.turns ?? []
    if (res?.filePath) reqSessionModalFilePath.value = res.filePath
  }
  catch { reqSessionModalTranscript.value = [] }
  finally { reqSessionModalTranscriptLoading.value = false }
}

function closeReqSessionModal() {
  showReqSessionModal.value = false
  reqSessionModalReqId.value = null
}

function toggleReqBlock(key: string) {
  const s = reqSessionExpandedBlocks.value
  if (s.has(key)) s.delete(key)
  else s.add(key)
  reqSessionExpandedBlocks.value = new Set(s)
}

function reqSessionProviderLabel(p: string): string {
  return { 'cursor': 'Cursor', 'claude-code': 'Claude Code', 'codex': 'Codex' }[p] ?? p
}

function reqFormatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function reqTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

function reqTruncateText(text: string, maxLen = 200): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`
}

function reqToolSummary(tc: ToolCall): string {
  const inp = tc.input
  if (tc.name === 'Read' || tc.name === 'read_file') return String(inp.path ?? inp.file_path ?? '')
  if (tc.name === 'Write' || tc.name === 'write_to_file') return String(inp.path ?? inp.file_path ?? '')
  if (tc.name === 'Bash' || tc.name === 'execute_command') return String(inp.command ?? '').slice(0, 80)
  if (tc.name === 'Shell') return String(inp.command ?? '').slice(0, 80)
  if (tc.name === 'Grep') return String(inp.pattern ?? '')
  return Object.values(inp).map(String).join(' ').slice(0, 60)
}

function reqFormatToolInput(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 顶栏 -->
    <div class="shrink-0 px-6 pt-6 pb-4 flex items-center justify-between">
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

    <!-- 看板 -->
    <div class="flex-1 overflow-x-auto overflow-y-hidden px-6 pb-6">
      <div class="flex gap-4 h-full min-w-min">
        <div
          v-for="col in groupedRequirements"
          :key="col.key"
          class="w-[272px] shrink-0 flex flex-col h-full rounded-xl bg-gray-100/60 dark:bg-white/[0.02]"
        >
          <!-- 列头 -->
          <div class="shrink-0 flex items-center gap-2 px-3.5 py-3">
            <span class="w-2 h-2 rounded-full shrink-0" :class="col.dot" />
            <span class="text-[13px] font-semibold text-gray-600 dark:text-gray-300">{{ col.label }}</span>
            <span class="ml-auto px-1.5 py-0.5 rounded-md text-[11px] font-medium tabular-nums" :class="col.badgeClass">
              {{ col.items.length }}
            </span>
          </div>

          <!-- 卡片列表 -->
          <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-2.5">
            <div
              v-for="req in col.items"
              :key="req.id"
              class="bg-white dark:bg-[#28282c] rounded-lg p-3.5 shadow-sm shadow-black/[0.04] dark:shadow-none transition-all duration-200 hover:shadow-md hover:shadow-black/[0.08] cursor-pointer"
              @click="openReqDetail(req.id)"
            >
              <!-- 标题 + 删除 -->
              <div class="flex items-start gap-2">
                <h4 class="flex-1 min-w-0 text-[13px] font-semibold leading-snug line-clamp-2">{{ req.title }}</h4>
                <button
                  class="shrink-0 p-0.5 rounded text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  title="删除需求"
                  @click.stop="confirmDelete(req.id)"
                >
                  <div class="i-carbon-trash-can w-3 h-3" />
                </button>
              </div>

              <!-- 来源 + 模式 + 时间 -->
              <div class="flex items-center gap-1.5 mt-1.5">
                <span
                  class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                  :class="sourceBadge[req.source]?.class"
                >
                  {{ sourceBadge[req.source]?.label }}
                </span>
                <span
                  v-if="req.mode === 'orchestrator'"
                  class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400"
                >
                  编排
                </span>
                <span class="text-[10px] text-gray-400 tabular-nums ml-auto">{{ formatDate(req.created_at) }}</span>
              </div>

              <!-- 描述 -->
              <p
                v-if="req.description && req.description !== req.title"
                class="text-[12px] text-gray-400 mt-1.5 line-clamp-2 leading-relaxed"
              >
                {{ req.description }}
              </p>

              <!-- 飞书链接 -->
              <div v-if="req.source === 'feishu'" class="flex items-center gap-2.5 mt-1.5">
                <a
                  v-if="req.source_url"
                  :href="req.source_url"
                  target="_blank"
                  class="inline-flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                  @click.stop
                >
                  <div class="i-carbon-launch w-2.5 h-2.5" />
                  飞书项目
                </a>
                <a
                  v-if="req.doc_url"
                  :href="req.doc_url"
                  target="_blank"
                  class="inline-flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                  @click.stop
                >
                  <div class="i-carbon-document w-2.5 h-2.5" />
                  需求文档
                </a>
              </div>

              <!-- 获取飞书需求状态 -->
              <div v-if="req.status === 'fetching'" class="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[11px] font-medium">
                <div class="i-carbon-circle-dash w-3 h-3 animate-spin" />
                正在获取飞书需求...
              </div>
              <div v-else-if="req.status === 'fetch_failed'" class="mt-2 space-y-1">
                <div class="w-full flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-50 dark:bg-red-500/10 text-red-500 dark:text-red-400 text-[10px]">
                  <div class="i-carbon-warning w-3 h-3 shrink-0" />
                  <span class="truncate">{{ req.fetch_error || '获取失败' }}</span>
                </div>
                <button
                  class="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-violet-600 text-white text-[11px] font-medium hover:bg-violet-500 transition-all duration-150 active:scale-[0.97]"
                  @click.stop="retryRequirementFetch(req.id)"
                >
                  <div class="i-carbon-restart w-3 h-3" />
                  重试获取
                </button>
              </div>

              <!-- 对话记录入口 -->
              <button
                v-if="req.source === 'feishu' && req.fetch_output"
                class="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors"
                @click.stop="openReqSessionModal(req.id)"
              >
                <div class="i-carbon-chat w-3 h-3" />
                查看对话记录
              </button>

              <!-- 关联任务 -->
              <div v-if="(taskMap[req.id] ?? []).length > 0" class="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-white/5">
                <div class="space-y-1.5">
                  <div v-for="task in taskMap[req.id]" :key="task.id">
                    <div
                      class="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors flex-wrap"
                      :class="{
                        'bg-amber-50 dark:bg-amber-500/10': task.phase_status === 'waiting_confirm',
                        'bg-orange-50 dark:bg-orange-500/10': task.phase_status === 'waiting_input',
                        'bg-red-50 dark:bg-red-500/10': task.phase_status === 'failed',
                        'bg-slate-50 dark:bg-slate-500/10 border border-dashed border-slate-300 dark:border-slate-600': task.phase_status === 'pending',
                        'bg-gray-100 dark:bg-gray-500/10': task.phase_status === 'suspended',
                        'bg-gray-50 dark:bg-white/5': !['waiting_confirm', 'waiting_input', 'failed', 'pending', 'suspended'].includes(task.phase_status),
                      }"
                    >
                      <div class="i-carbon-folder-details w-3 h-3 text-gray-400 opacity-60 shrink-0" />
                      <span class="text-gray-600 dark:text-gray-300 truncate">{{ task.repoName }}</span>
                      <span class="text-gray-300 dark:text-gray-600">·</span>
                      <template v-if="task.phase_status === 'pending'">
                        <span class="text-slate-500 dark:text-slate-400 truncate">待选择工作流</span>
                        <div class="i-carbon-play-filled w-2.5 h-2.5 text-indigo-500 opacity-60 shrink-0" />
                      </template>
                      <template v-else>
                        <span class="truncate" :class="phaseStatusClass(task.phase_status)">
                          {{ allPhaseNameMap[task.current_phase] ?? task.current_phase }}
                          ({{ phaseStatusLabels[task.phase_status] || task.phase_status }})
                        </span>
                        <div
                          v-if="task.phase_status === 'waiting_confirm' || task.phase_status === 'waiting_input'"
                          class="w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
                          :class="task.phase_status === 'waiting_input' ? 'bg-orange-400' : 'bg-amber-400'"
                        />
                      </template>
                      <button
                        v-if="task.phase_status === 'failed' || task.phase_status === 'cancelled'"
                        class="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-colors text-[10px] shrink-0"
                        :disabled="tasksStore.retrying.has(task.id)"
                        @click.stop="retryTask(task.id)"
                      >
                        <div
                          class="w-2.5 h-2.5"
                          :class="tasksStore.retrying.has(task.id) ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-restart'"
                        />
                        {{ tasksStore.retrying.has(task.id) ? '重试中' : '重试' }}
                      </button>
                    </div>
                    <div
                      v-if="tasksStore.taskErrors[task.id]"
                      class="mt-1 px-2 py-1 rounded bg-red-50 dark:bg-red-500/5 text-[10px] text-red-500 dark:text-red-400 leading-relaxed break-all"
                    >
                      {{ tasksStore.taskErrors[task.id] }}
                    </div>
                  </div>
                </div>
                <button
                  v-if="reposStore.repos.length > (taskMap[req.id] ?? []).length && !['fetching', 'fetch_failed'].includes(req.status)"
                  class="mt-1.5 flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-600 transition-colors"
                  @click.stop="openDispatchDialog(req.id)"
                >
                  <div class="i-carbon-add w-3 h-3" />
                  分发到更多仓库
                </button>
              </div>

              <!-- 无任务 -->
              <div v-else class="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-white/5 flex items-center justify-between">
                <span class="text-[11px] text-gray-300 dark:text-gray-600">暂无任务</span>
                <button
                  v-if="reposStore.repos.length > 0 && !['fetching', 'fetch_failed'].includes(req.status)"
                  class="flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-600 text-white text-[11px] font-medium hover:bg-indigo-500 transition-all duration-150 active:scale-[0.97]"
                  @click.stop="openDispatchDialog(req.id)"
                >
                  <div class="i-carbon-deploy w-3 h-3" />
                  分发
                </button>
                <span v-else class="text-[11px] text-gray-300 dark:text-gray-500">请先添加仓库</span>
              </div>
            </div>

            <!-- 空列占位 -->
            <div v-if="col.items.length === 0" class="flex flex-col items-center justify-center py-10 text-gray-300 dark:text-gray-600">
              <div :class="col.icon" class="w-6 h-6 mb-2 opacity-30" />
              <span class="text-[11px]">暂无需求</span>
            </div>
          </div>
        </div>
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
              <div v-if="createMode === 'manual'" class="space-y-3">
                <input
                  v-model="manualTitle"
                  type="text"
                  placeholder="需求标题（可选，留空则自动生成）"
                  class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                >
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

              <!-- 执行模式 -->
              <div class="mt-4 pt-4 border-t border-gray-100 dark:border-white/5">
                <div class="text-[12px] font-medium text-gray-600 dark:text-gray-300 mb-2">执行模式</div>
                <div class="flex gap-2">
                  <button
                    class="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium border transition-all"
                    :class="requirementMode === 'workflow'
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-400'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5'"
                    @click="requirementMode = 'workflow'"
                  >
                    <div class="i-carbon-flow w-4 h-4 mx-auto mb-1 opacity-60" />
                    流水线
                    <div class="text-[10px] opacity-60 mt-0.5">按阶段推进</div>
                  </button>
                  <button
                    class="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium border transition-all"
                    :class="requirementMode === 'orchestrator'
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-400'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5'"
                    @click="requirementMode = 'orchestrator'"
                  >
                    <div class="i-carbon-group w-4 h-4 mx-auto mb-1 opacity-60" />
                    多 Agent 编排
                    <div class="text-[10px] opacity-60 mt-0.5">自动分配执行</div>
                  </button>
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
                选择要分发的仓库，将为每个仓库创建独立任务（分发后可在仓库页面选择工作流并启动）
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
                  @click="dispatchToRepos"
                >
                  <div v-if="dispatching" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                  <div v-else class="i-carbon-deploy w-4 h-4" />
                  {{ dispatching ? '分发中...' : `分发到仓库 (${selectedRepoIds.length})` }}
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

    <!-- ── 需求详情滑出面板 ── -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-200 ease-out"
        leave-active-class="transition-opacity duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="selectedReqId && selectedReq"
          class="fixed inset-0 z-50 flex justify-end"
        >
          <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]" @click="selectedReqId = null" />
          <Transition
            appear
            enter-active-class="transition-transform duration-250 ease-out"
            enter-from-class="translate-x-full"
            leave-active-class="transition-transform duration-200 ease-in"
            leave-to-class="translate-x-full"
          >
            <div class="relative w-full max-w-lg bg-white dark:bg-[#1e1e22] shadow-2xl shadow-black/15 flex flex-col h-full overflow-hidden">
              <!-- 面板头 -->
              <div class="shrink-0 flex items-start gap-3 px-6 pt-5 pb-4 border-b border-gray-100 dark:border-white/5">
                <div class="flex-1 min-w-0">
                  <h2 class="text-[16px] font-semibold leading-snug mb-2">{{ selectedReq.title }}</h2>
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      class="px-2 py-0.5 rounded-md text-[11px] font-medium"
                      :class="statusBadge[deriveEffectiveStatus(selectedReq)]?.class"
                    >
                      {{ statusBadge[deriveEffectiveStatus(selectedReq)]?.label }}
                    </span>
                    <span
                      class="px-2 py-0.5 rounded-md text-[11px] font-medium"
                      :class="sourceBadge[selectedReq.source]?.class"
                    >
                      {{ sourceBadge[selectedReq.source]?.label }}
                    </span>
                    <span class="text-[11px] text-gray-400 tabular-nums">{{ formatDate(selectedReq.created_at) }}</span>
                  </div>
                </div>
                <button
                  class="shrink-0 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="selectedReqId = null"
                >
                  <div class="i-carbon-close w-4 h-4 text-gray-400" />
                </button>
              </div>

              <!-- 面板主体 -->
              <div class="flex-1 overflow-y-auto">
                <!-- 执行模式切换 -->
                <div v-if="selectedReq.status === 'draft'" class="px-6 py-4 border-b border-gray-100 dark:border-white/5">
                  <div class="text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">执行模式</div>
                  <div class="flex gap-2">
                    <button
                      class="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium border transition-all text-center"
                      :class="selectedReq.mode === 'workflow'
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-400'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5'"
                      @click="requirementsStore.updateMode(selectedReq.id, 'workflow')"
                    >
                      <div class="i-carbon-flow w-4 h-4 mx-auto mb-1 opacity-60" />
                      流水线
                    </button>
                    <button
                      class="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium border transition-all text-center"
                      :class="selectedReq.mode === 'orchestrator'
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-400'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5'"
                      @click="requirementsStore.updateMode(selectedReq.id, 'orchestrator')"
                    >
                      <div class="i-carbon-group w-4 h-4 mx-auto mb-1 opacity-60" />
                      多 Agent 编排
                    </button>
                  </div>
                  <button
                    class="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 bg-violet-600 text-white hover:bg-violet-500 shadow-sm shadow-violet-600/20"
                    :disabled="orchestratorDispatching"
                    @click="dispatchToOrchestrator(selectedReq.id)"
                  >
                    <div v-if="orchestratorDispatching" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                    <div v-else class="i-carbon-send-alt w-4 h-4" />
                    派发给多 Agent 编排
                  </button>
                </div>
                <!-- pending: 已派发到编排，等待处理 -->
                <div v-else-if="selectedReq.status === 'pending' && selectedReq.mode === 'orchestrator'" class="px-6 py-4 border-b border-gray-100 dark:border-white/5">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-[11px] text-gray-400">执行模式:</span>
                    <span class="px-2 py-0.5 rounded-md text-[11px] font-medium bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400">
                      多 Agent 编排
                    </span>
                  </div>
                  <div class="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-blue-50/80 dark:bg-blue-500/5 border border-blue-200/60 dark:border-blue-500/10">
                    <div class="i-carbon-circle-dash w-4 h-4 text-blue-500 animate-spin shrink-0" />
                    <span class="text-[12px] font-medium text-blue-600 dark:text-blue-400">已派发，等待 Leader 分析分配...</span>
                  </div>
                </div>
                <!-- 非 draft/pending 状态只读显示 -->
                <div v-else class="px-6 py-3 border-b border-gray-100 dark:border-white/5 flex items-center gap-2">
                  <span class="text-[11px] text-gray-400">执行模式:</span>
                  <span class="px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">
                    {{ selectedReq.mode === 'orchestrator' ? '多 Agent 编排' : '流水线' }}
                  </span>
                </div>

                <!-- 获取进度 / 获取结果 -->
                <div v-if="selectedReq.status === 'fetching' || selectedReq.status === 'fetch_failed' || selectedReq.fetch_output" class="px-6 py-4 border-b border-gray-100 dark:border-white/5">
                  <!-- 标题栏 -->
                  <div class="flex items-center gap-2 mb-3">
                    <template v-if="selectedReq.status === 'fetching'">
                      <div class="i-carbon-circle-dash w-4 h-4 text-violet-500 animate-spin" />
                      <h3 class="text-[12px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wider">正在获取飞书需求...</h3>
                    </template>
                    <template v-else-if="selectedReq.status === 'fetch_failed'">
                      <div class="i-carbon-warning w-4 h-4 text-red-500" />
                      <h3 class="text-[12px] font-semibold text-red-600 dark:text-red-400 uppercase tracking-wider">获取失败</h3>
                    </template>
                    <template v-else>
                      <div class="i-carbon-checkmark w-4 h-4 text-emerald-500" />
                      <h3 class="text-[12px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">获取记录</h3>
                    </template>
                  </div>

                  <!-- CLI / 模型 标签 -->
                  <div v-if="selectedReq.fetch_cli_type || selectedReq.fetch_model" class="flex items-center gap-2 mb-3 flex-wrap">
                    <span v-if="selectedReq.fetch_cli_type" class="px-2 py-0.5 rounded-md text-[10px] font-medium bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">
                      {{ { 'cursor-cli': 'Cursor', 'claude-code': 'Claude Code', 'codex': 'Codex' }[selectedReq.fetch_cli_type] ?? selectedReq.fetch_cli_type }}
                    </span>
                    <span v-if="selectedReq.fetch_model" class="px-2 py-0.5 rounded-md text-[10px] font-medium bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400">
                      {{ selectedReq.fetch_model }}
                    </span>
                  </div>

                  <!-- 输入提示词 -->
                  <details v-if="selectedReq.fetch_prompt" class="group mb-3">
                    <summary class="cursor-pointer text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors select-none flex items-center gap-1.5">
                      <div class="i-carbon-document w-3 h-3" />
                      查看输入提示词
                    </summary>
                    <div class="mt-2 rounded-lg bg-gray-50 dark:bg-white/3 border border-gray-100 dark:border-white/5 p-4 max-h-80 overflow-y-auto">
                      <pre class="text-[11px] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">{{ selectedReq.fetch_prompt }}</pre>
                    </div>
                  </details>

                  <!-- 错误信息 -->
                  <p v-if="selectedReq.status === 'fetch_failed' && selectedReq.fetch_error" class="text-[12px] text-red-500 dark:text-red-400 mb-3 whitespace-pre-wrap">{{ selectedReq.fetch_error }}</p>

                  <!-- 输出内容 -->
                  <div v-if="selectedReq.status === 'fetching' && reqLiveOutput" class="rounded-lg bg-gray-900 dark:bg-gray-950 p-4 max-h-80 overflow-y-auto">
                    <pre class="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">{{ reqLiveOutput }}</pre>
                  </div>
                  <div v-else-if="selectedReq.status === 'fetching' && !reqLiveOutput" class="text-[12px] text-gray-400">等待 Agent 输出...</div>
                  <details v-else-if="selectedReq.fetch_output" class="group">
                    <summary class="cursor-pointer text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors select-none">
                      {{ selectedReq.status === 'fetch_failed' ? '查看获取输出' : '展开获取过程' }}
                    </summary>
                    <div class="mt-2 rounded-lg bg-gray-900 dark:bg-gray-950 p-4 max-h-80 overflow-y-auto">
                      <pre class="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap font-mono">{{ selectedReq.fetch_output }}</pre>
                    </div>
                  </details>

                  <!-- 重试按钮 -->
                  <button
                    v-if="selectedReq.status === 'fetch_failed'"
                    class="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-[12px] font-medium hover:bg-violet-500 transition-all duration-150 active:scale-[0.97]"
                    @click="retryRequirementFetch(selectedReq.id)"
                  >
                    <div class="i-carbon-restart w-3.5 h-3.5" />
                    重试获取
                  </button>
                </div>

                <!-- 对话历史 -->
                <!-- 描述 -->
                <div v-if="selectedReq.description" class="px-6 py-4 border-b border-gray-100 dark:border-white/5">
                  <h3 class="text-[12px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">描述</h3>
                  <p class="text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">{{ selectedReq.description }}</p>
                </div>

                <!-- 关联链接 -->
                <div v-if="selectedReq.source === 'feishu' && (selectedReq.source_url || selectedReq.doc_url)" class="px-6 py-4 border-b border-gray-100 dark:border-white/5">
                  <h3 class="text-[12px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">关联链接</h3>
                  <div class="space-y-1.5">
                    <a
                      v-if="selectedReq.source_url"
                      :href="selectedReq.source_url"
                      target="_blank"
                      class="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/3 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                    >
                      <div class="i-carbon-launch w-3.5 h-3.5 text-blue-500" />
                      <span class="text-[12px] text-blue-600 dark:text-blue-400">飞书项目</span>
                      <span class="text-[11px] text-gray-400 truncate ml-auto font-mono">{{ selectedReq.source_url.replace(/https?:\/\//, '').slice(0, 40) }}...</span>
                    </a>
                    <a
                      v-if="selectedReq.doc_url"
                      :href="selectedReq.doc_url"
                      target="_blank"
                      class="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/3 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                    >
                      <div class="i-carbon-document w-3.5 h-3.5 text-blue-500" />
                      <span class="text-[12px] text-blue-600 dark:text-blue-400">需求文档</span>
                      <span class="text-[11px] text-gray-400 truncate ml-auto font-mono">{{ selectedReq.doc_url.replace(/https?:\/\//, '').slice(0, 40) }}...</span>
                    </a>
                  </div>
                </div>

                <!-- 关联任务 -->
                <div class="px-6 py-4">
                  <div class="flex items-center justify-between mb-3">
                    <h3 class="text-[12px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                      关联任务
                      <span v-if="selectedReqTasks.length" class="ml-1">({{ selectedReqTasks.length }})</span>
                    </h3>
                    <button
                      v-if="selectedReq?.mode !== 'orchestrator' && reposStore.repos.length > selectedReqTasks.length && !['fetching', 'fetch_failed'].includes(selectedReq?.status ?? '')"
                      class="flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-600 transition-colors"
                      @click="openDispatchDialog(selectedReqId!); selectedReqId = null"
                    >
                      <div class="i-carbon-add w-3 h-3" />
                      分发到仓库
                    </button>
                  </div>

                  <div v-if="selectedReqTasks.length > 0" class="space-y-2">
                    <router-link
                      v-for="task in selectedReqTasks"
                      :key="task.id"
                      :to="`/repo/${task.repo_id}/task/${task.id}`"
                      class="block rounded-lg border border-gray-100 dark:border-white/5 hover:border-indigo-200 dark:hover:border-indigo-500/20 transition-colors overflow-hidden"
                    >
                      <div
                        class="flex items-center gap-2.5 px-3.5 py-2.5"
                        :class="{
                          'bg-amber-50/50 dark:bg-amber-500/5': task.phase_status === 'waiting_confirm',
                          'bg-orange-50/50 dark:bg-orange-500/5': task.phase_status === 'waiting_input',
                          'bg-red-50/50 dark:bg-red-500/5': task.phase_status === 'failed',
                          'bg-slate-50/80 dark:bg-slate-500/5 border-dashed': task.phase_status === 'pending',
                          'bg-gray-50/50 dark:bg-white/[0.02]': !['waiting_confirm', 'waiting_input', 'failed', 'pending'].includes(task.phase_status),
                        }"
                      >
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 mb-1">
                            <div class="i-carbon-folder-details w-3.5 h-3.5 text-gray-400 shrink-0" />
                            <span class="text-[13px] font-medium text-gray-700 dark:text-gray-200 truncate">{{ task.repoName }}</span>
                          </div>
                          <div class="flex items-center gap-2 pl-5.5">
                            <template v-if="task.phase_status === 'pending'">
                              <span class="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                待选择工作流
                              </span>
                              <div class="i-carbon-play-filled w-3 h-3 text-indigo-500 opacity-60" />
                            </template>
                            <template v-else>
                              <span
                                class="text-[11px] font-medium"
                                :class="phaseStatusClass(task.phase_status)"
                              >
                                {{ allPhaseNameMap[task.current_phase] ?? task.current_phase }}
                                · {{ phaseStatusLabels[task.phase_status] || task.phase_status }}
                              </span>
                              <div
                                v-if="task.phase_status === 'waiting_confirm' || task.phase_status === 'waiting_input'"
                                class="w-1.5 h-1.5 rounded-full animate-pulse shrink-0"
                                :class="task.phase_status === 'waiting_input' ? 'bg-orange-400' : 'bg-amber-400'"
                              />
                            </template>
                          </div>
                        </div>
                        <div class="i-carbon-chevron-right w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0" />
                      </div>
                      <!-- 错误信息 -->
                      <div
                        v-if="tasksStore.taskErrors[task.id]"
                        class="px-3.5 py-2 bg-red-50 dark:bg-red-500/5 border-t border-red-100 dark:border-red-500/10 text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all"
                      >
                        {{ tasksStore.taskErrors[task.id] }}
                      </div>
                    </router-link>
                  </div>
                  <div v-else class="text-center py-8 text-gray-300 dark:text-gray-600">
                    <div class="i-carbon-task w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p class="text-[12px]">暂无关联任务</p>
                    <button
                      v-if="selectedReq?.mode !== 'orchestrator' && reposStore.repos.length > 0 && !['fetching', 'fetch_failed'].includes(selectedReq?.status ?? '')"
                      class="mt-3 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[12px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] mx-auto"
                      @click="openDispatchDialog(selectedReqId!); selectedReqId = null"
                    >
                      <div class="i-carbon-deploy w-3.5 h-3.5" />
                      分发到仓库
                    </button>
                  </div>
                </div>
              </div>

              <!-- 面板底栏 -->
              <div class="shrink-0 flex items-center gap-2 px-6 py-3 border-t border-gray-100 dark:border-white/5 bg-gray-50/50 dark:bg-white/[0.01]">
                <button
                  v-if="selectedReq.source === 'feishu' && selectedReq.fetch_output"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="openReqSessionModal(selectedReq.id)"
                >
                  <div class="i-carbon-chat w-3.5 h-3.5" />
                  对话记录
                </button>
                <div class="flex-1" />
                <button
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  @click="confirmDelete(selectedReqId!); selectedReqId = null"
                >
                  <div class="i-carbon-trash-can w-3.5 h-3.5" />
                  删除需求
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
    <!-- ── 需求会话详情弹窗 ── -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showReqSessionModal" class="fixed inset-0 z-50 flex">
          <div class="absolute inset-0 bg-black/40 backdrop-blur-[2px]" @click="closeReqSessionModal" />
          <div class="relative ml-auto w-full max-w-3xl h-full bg-white dark:bg-[#1e1e22] shadow-2xl flex flex-col">
            <!-- Header -->
            <div class="flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-white/5 shrink-0">
              <button class="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors" @click="closeReqSessionModal">
                <div class="i-carbon-close w-4 h-4 text-gray-400" />
              </button>
              <div class="flex-1 min-w-0">
                <h2 class="text-[14px] font-semibold">Agent 对话记录</h2>
                <p class="text-[11px] text-gray-400 mt-0.5">需求获取过程中的所有 Agent 会话</p>
              </div>
            </div>

            <!-- Body -->
            <div class="flex-1 overflow-y-auto">
              <!-- Loading -->
              <div v-if="reqSessionModalLoading" class="flex items-center justify-center py-12 text-[12px] text-gray-400">
                <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
                扫描会话文件...
              </div>

              <!-- Session list + transcript -->
              <div v-else-if="reqSessionModalSessions.length > 0" class="flex h-full">
                <!-- Left: session list -->
                <div class="w-72 shrink-0 border-r border-gray-100 dark:border-white/5 overflow-y-auto p-3 space-y-2">
                  <div
                    v-for="session in reqSessionModalSessions"
                    :key="session.sessionId"
                    class="group p-3 rounded-xl border cursor-pointer transition-all"
                    :class="reqSessionModalSelectedId === session.sessionId
                      ? 'bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/20'
                      : 'bg-white dark:bg-[#28282c] border-gray-100 dark:border-white/[0.04] hover:border-gray-200 dark:hover:border-white/[0.1]'"
                    @click="openReqSessionTranscript(session)"
                  >
                    <div class="flex items-center gap-2 mb-1.5">
                      <div class="i-carbon-chat w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                      <span class="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate">{{ session.sessionId.slice(0, 12) }}</span>
                    </div>
                    <p v-if="session.firstTurnPreview" class="text-[11px] text-gray-600 dark:text-gray-300 leading-relaxed line-clamp-2 mb-2">{{ session.firstTurnPreview }}</p>
                    <div class="flex items-center gap-2 text-[10px] text-gray-400">
                      <span class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 font-medium">{{ reqSessionProviderLabel(session.provider) }}</span>
                      <span>{{ reqFormatFileSize(session.sizeBytes) }}</span>
                      <span>{{ reqTimeAgo(session.modifiedAt) }}</span>
                    </div>
                  </div>
                </div>

                <!-- Right: transcript -->
                <div class="flex-1 overflow-y-auto">
                  <div v-if="!reqSessionModalSelectedId" class="flex items-center justify-center h-full text-gray-300 dark:text-gray-600 text-[13px]">
                    <div class="text-center">
                      <div class="i-carbon-chat w-10 h-10 mx-auto mb-2 opacity-30" />
                      <p>选择一个会话查看详情</p>
                    </div>
                  </div>
                  <div v-else-if="reqSessionModalTranscriptLoading" class="flex items-center justify-center h-full text-[13px] text-gray-400">
                    <div class="i-carbon-circle-dash w-5 h-5 animate-spin mr-2" />
                    加载会话数据...
                  </div>
                  <div v-else-if="reqSessionModalTranscript.length > 0" class="p-4 space-y-4">
                    <div v-for="turn in reqSessionModalTranscript" :key="turn.index" class="turn-group">
                      <!-- User message -->
                      <div v-if="turn.user_text" class="mb-3">
                        <div class="flex items-center gap-2 mb-1.5">
                          <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">Turn {{ turn.index }}</span>
                          <span v-if="turn.timestamp" class="text-[10px] text-gray-400 tabular-nums">{{ turn.timestamp }}</span>
                        </div>
                        <div class="rounded-xl px-4 py-3 bg-indigo-50/50 dark:bg-indigo-500/[0.04] border border-indigo-100 dark:border-indigo-500/10">
                          <p class="text-[13px] leading-relaxed text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{{ turn.user_text }}</p>
                        </div>
                      </div>
                      <div v-else class="flex items-center gap-2 mb-2">
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400">Turn {{ turn.index }}</span>
                      </div>

                      <!-- Assistant blocks -->
                      <div class="space-y-2 pl-3 border-l-2 border-emerald-200 dark:border-emerald-500/20">
                        <template v-for="(block, bIdx) in turn.blocks" :key="bIdx">
                          <!-- Text -->
                          <div v-if="block.kind === 'text'" class="rounded-xl px-4 py-3 bg-white dark:bg-[#28282c] border border-gray-100 dark:border-white/[0.04] shadow-sm shadow-black/[0.02] dark:shadow-none">
                            <p class="text-[13px] leading-relaxed text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{{ block.text }}</p>
                          </div>

                          <!-- Thinking -->
                          <div v-else-if="block.kind === 'thinking'" class="rounded-lg overflow-hidden border border-purple-200/50 dark:border-purple-500/10">
                            <button
                              class="w-full flex items-center gap-2 px-3 py-2 text-left bg-purple-50/50 dark:bg-purple-500/[0.03] hover:bg-purple-50 dark:hover:bg-purple-500/5 transition-colors"
                              @click="toggleReqBlock(`think-${turn.index}-${bIdx}`)"
                            >
                              <div class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150" :class="reqSessionExpandedBlocks.has(`think-${turn.index}-${bIdx}`) && 'rotate-90'" />
                              <div class="i-carbon-idea w-3.5 h-3.5 text-purple-500" />
                              <span class="text-[12px] font-medium text-purple-600 dark:text-purple-400">Thinking</span>
                              <span class="text-[11px] text-gray-400 truncate flex-1">{{ reqTruncateText(block.text, 80) }}</span>
                            </button>
                            <div v-if="reqSessionExpandedBlocks.has(`think-${turn.index}-${bIdx}`)" class="px-4 py-3 bg-purple-50/30 dark:bg-purple-500/[0.02]">
                              <p class="text-[12px] leading-relaxed text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{{ block.text }}</p>
                            </div>
                          </div>

                          <!-- Tool use -->
                          <div v-else-if="block.kind === 'tool_use' && block.tool_call" class="rounded-lg overflow-hidden border" :class="block.tool_call.is_error ? 'border-red-200 dark:border-red-500/15' : 'border-gray-200 dark:border-white/[0.06]'">
                            <button
                              class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                              :class="block.tool_call.is_error ? 'bg-red-50/50 dark:bg-red-500/[0.03]' : 'bg-gray-50 dark:bg-[#1a1a1e] hover:bg-gray-100 dark:hover:bg-white/5'"
                              @click="toggleReqBlock(`tool-${turn.index}-${bIdx}`)"
                            >
                              <div class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150" :class="reqSessionExpandedBlocks.has(`tool-${turn.index}-${bIdx}`) && 'rotate-90'" />
                              <div class="w-3.5 h-3.5" :class="block.tool_call.is_error ? 'i-carbon-warning-alt text-red-500' : 'i-carbon-terminal text-blue-500'" />
                              <span class="text-[12px] font-medium" :class="block.tool_call.is_error ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'">{{ block.tool_call.name }}</span>
                              <span class="text-[11px] text-gray-400 truncate flex-1 font-mono">{{ reqToolSummary(block.tool_call) }}</span>
                              <span v-if="block.tool_call.result !== null" class="shrink-0">
                                <div v-if="block.tool_call.is_error" class="i-carbon-close-filled w-3 h-3 text-red-400" />
                                <div v-else class="i-carbon-checkmark-filled w-3 h-3 text-emerald-400" />
                              </span>
                            </button>
                            <div v-if="reqSessionExpandedBlocks.has(`tool-${turn.index}-${bIdx}`)" class="border-t border-gray-100 dark:border-white/[0.04]">
                              <div class="px-3 py-2 bg-[#fafafa] dark:bg-[#161618]">
                                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Input</div>
                                <pre class="text-[11px] font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">{{ reqFormatToolInput(block.tool_call.input) }}</pre>
                              </div>
                              <div v-if="block.tool_call.result !== null" class="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04]" :class="block.tool_call.is_error ? 'bg-red-50/30 dark:bg-red-500/[0.02]' : 'bg-emerald-50/30 dark:bg-emerald-500/[0.02]'">
                                <div class="text-[10px] font-bold uppercase tracking-wider mb-1" :class="block.tool_call.is_error ? 'text-red-400' : 'text-emerald-500'">{{ block.tool_call.is_error ? 'Error' : 'Result' }}</div>
                                <pre class="text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto" :class="block.tool_call.is_error ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'">{{ block.tool_call.result }}</pre>
                              </div>
                            </div>
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                  <div v-else class="flex items-center justify-center h-full text-gray-300 dark:text-gray-600 text-[13px]">
                    <div class="text-center">
                      <div class="i-carbon-data-base w-10 h-10 mx-auto mb-2 opacity-30" />
                      <p>无法解析此会话文件</p>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Empty -->
              <div v-else class="flex flex-col items-center justify-center py-12 text-gray-300 dark:text-gray-600">
                <div class="i-carbon-data-base w-8 h-8 mb-2 opacity-30" />
                <p class="text-[13px]">未找到该需求的 Agent 会话文件</p>
              </div>
            </div>

            <!-- Footer -->
            <div v-if="reqSessionModalFilePath" class="shrink-0 px-5 py-2 border-t border-gray-100 dark:border-white/[0.03] text-[10px] font-mono text-gray-400 dark:text-gray-600 truncate">
              {{ reqSessionModalFilePath }}
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-active > div:last-child,
.modal-leave-active > div:last-child {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from > div:last-child {
  transform: translateX(40px);
  opacity: 0;
}
.modal-leave-to > div:last-child {
  transform: translateX(40px);
  opacity: 0;
}
</style>
