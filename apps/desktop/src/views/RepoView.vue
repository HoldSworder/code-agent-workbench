<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTasksStore } from '../stores/tasks'
import { useRequirementsStore } from '../stores/requirements'
import { useReposStore } from '../stores/repos'
import { rpc } from '../composables/use-sidecar'
import CursorTerminal from '../components/CursorTerminal.vue'
import MarkdownIt from 'markdown-it'

const SESSION_PAGE = 30

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const route = useRoute()
const router = useRouter()

const repoId = computed(() => route.params.id as string)
const tasksStore = useTasksStore()
const requirementsStore = useRequirementsStore()
const reposStore = useReposStore()

interface WorkflowPhase {
  id: string
  name: string
}
interface WorkflowStage {
  id: string
  name: string
  phases: WorkflowPhase[]
}
const workflowStages = ref<WorkflowStage[]>([])

const phaseNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const stage of workflowStages.value) {
    for (const phase of stage.phases) {
      map[phase.id] = phase.name
    }
  }
  return map
})

const stageNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const stage of workflowStages.value) {
    for (const phase of stage.phases) {
      map[phase.id] = stage.name
    }
  }
  return map
})

// ── Workflow selection for pending tasks ──

interface WorkflowInfo {
  id: string
  name: string
  description: string
}

const availableWorkflows = ref<WorkflowInfo[]>([])
const showWorkflowPicker = ref(false)
const workflowPickerTaskId = ref('')
const selectedWorkflowId = ref('')
const startingWorkflow = ref(false)

function openWorkflowPicker(taskId: string) {
  workflowPickerTaskId.value = taskId
  selectedWorkflowId.value = availableWorkflows.value[0]?.id ?? ''
  showWorkflowPicker.value = true
}

async function confirmStartWithWorkflow() {
  const taskId = workflowPickerTaskId.value
  if (!taskId || !selectedWorkflowId.value) return
  startingWorkflow.value = true
  try {
    await rpc('workflow.start', {
      repoTaskId: taskId,
      workflowId: selectedWorkflowId.value,
    })
    showWorkflowPicker.value = false
    await tasksStore.fetchByRepo(repoId.value)
    router.push(`/repo/${repoId.value}/task/${taskId}?workflowId=${selectedWorkflowId.value}`)
  }
  catch (err) {
    console.error('Failed to start workflow:', err)
  }
  finally {
    startingWorkflow.value = false
  }
}

function handleTaskClick(task: { id: string, phase_status: string }) {
  if (task.phase_status === 'pending') {
    openWorkflowPicker(task.id)
  }
  else {
    openTask(task.id)
  }
}

const statusConfig: Record<string, { label: string, dotClass: string, badgeClass: string }> = {
  pending: {
    label: '待启动',
    dotClass: 'bg-gray-400 dark:bg-gray-500',
    badgeClass: 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400',
  },
  running: {
    label: '运行中',
    dotClass: 'bg-indigo-500 animate-pulse',
    badgeClass: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400',
  },
  waiting_input: {
    label: '待反馈',
    dotClass: 'bg-orange-400 animate-pulse',
    badgeClass: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400',
  },
  waiting_confirm: {
    label: '待确认',
    dotClass: 'bg-amber-400 animate-pulse',
    badgeClass: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  },
  waiting_event: {
    label: '等待事件',
    dotClass: 'bg-blue-400',
    badgeClass: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  },
  suspended: {
    label: '已挂起',
    dotClass: 'bg-gray-400 dark:bg-gray-500',
    badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
  failed: {
    label: '失败',
    dotClass: 'bg-red-500',
    badgeClass: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  },
  completed: {
    label: '已完成',
    dotClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  },
  cancelled: {
    label: '已取消',
    dotClass: 'bg-gray-400 dark:bg-gray-600',
    badgeClass: 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-500',
  },
}

const repoName = computed(() => {
  const repo = reposStore.repos.find(r => r.id === repoId.value)
  return repo?.alias || repo?.name || repoId.value
})

const requirementById = computed(() =>
  Object.fromEntries(requirementsStore.requirements.map(r => [r.id, r])),
)

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_confirm', 'waiting_event', 'failed'])

const pendingTasks = computed(() =>
  tasksStore.tasks
    .filter(t => t.phase_status === 'pending')
    .sort((a, b) => normalizeTime(b.updated_at) - normalizeTime(a.updated_at)),
)

const activeTasks = computed(() =>
  tasksStore.tasks
    .filter(t => ACTIVE_STATUSES.has(t.phase_status))
    .sort((a, b) => normalizeTime(b.updated_at) - normalizeTime(a.updated_at)),
)

const historyTasks = computed(() =>
  tasksStore.tasks
    .filter(t => t.phase_status !== 'pending' && !ACTIVE_STATUSES.has(t.phase_status))
    .sort((a, b) => normalizeTime(b.updated_at) - normalizeTime(a.updated_at)),
)

function normalizeTime(iso: string): number {
  const s = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(s).getTime()
}

function timeAgo(iso: string) {
  const diff = Date.now() - normalizeTime(iso)
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

function formatDate(iso: string) {
  const s = iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
  return new Date(s).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function requirementTitle(reqId: string) {
  return requirementById.value[reqId]?.title ?? reqId
}

function openTask(taskId: string) {
  router.push(`/repo/${repoId.value}/task/${taskId}`)
}

// ── Sessions ──

interface SessionSummary {
  sessionId: string
  filePath: string
  provider: string
  modifiedAt: string
  sizeBytes: number
  firstTurnPreview?: string | null
}

interface ToolCall {
  tool_use_id: string
  name: string
  input: Record<string, any>
  result: string | null
  resultTimestamp: string | null
  is_error: boolean
}

interface AssistantBlock {
  kind: 'text' | 'thinking' | 'tool_use'
  text: string
  tool_call: ToolCall | null
  timestamp: string | null
}

interface TranscriptTurn {
  index: number
  user_text: string
  blocks: AssistantBlock[]
  timestamp: string
}

const sessions = ref<SessionSummary[]>([])
const sessionsTotal = ref(0)
const loadingSessions = ref(false)
const loadingMoreSessions = ref(false)
const showSessionDetail = ref(false)
const selectedSession = ref<SessionSummary | null>(null)
const transcriptTurns = ref<TranscriptTurn[]>([])
const transcriptFormat = ref('')
const transcriptFilePath = ref<string | null>(null)
const loadingTranscript = ref(false)
const expandedBlocks = ref<Set<string>>(new Set())

async function loadSessions(reset = true) {
  if (reset) {
    loadingSessions.value = true
  }
  else {
    if (loadingMoreSessions.value || loadingSessions.value) return
    if (sessions.value.length >= sessionsTotal.value) return
    loadingMoreSessions.value = true
  }
  try {
    const offset = reset ? 0 : sessions.value.length
    const res = await rpc<{ items: SessionSummary[], total: number }>('repo.sessions', {
      repoId: repoId.value,
      limit: SESSION_PAGE,
      offset,
    })
    const items = res?.items ?? []
    const total = res?.total ?? 0
    sessionsTotal.value = total
    if (reset)
      sessions.value = items
    else
      sessions.value = [...sessions.value, ...items]
  }
  catch {
    if (reset) {
      sessions.value = []
      sessionsTotal.value = 0
    }
  }
  finally {
    loadingSessions.value = false
    loadingMoreSessions.value = false
  }
}

async function loadMoreSessions() {
  await loadSessions(false)
}

function onSessionsScroll(e: Event) {
  const el = e.target as HTMLElement
  if (loadingMoreSessions.value || loadingSessions.value) return
  if (sessions.value.length >= sessionsTotal.value) return
  const threshold = 120
  if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
    void loadMoreSessions()
}

async function openSession(session: SessionSummary) {
  selectedSession.value = session
  showSessionDetail.value = true
  transcriptTurns.value = []
  transcriptFormat.value = ''
  transcriptFilePath.value = null
  loadingTranscript.value = true
  try {
    const res = await rpc<{ turns: TranscriptTurn[], format: string, filePath: string | null }>(
      'repo.sessionTranscript',
      { sessionId: session.sessionId },
    )
    transcriptTurns.value = res?.turns ?? []
    transcriptFormat.value = res?.format ?? ''
    transcriptFilePath.value = res?.filePath ?? null
  }
  catch { transcriptTurns.value = [] }
  finally { loadingTranscript.value = false }
}

function closeSessionDetail() {
  showSessionDetail.value = false
  selectedSession.value = null
  transcriptTurns.value = []
  expandedBlocks.value = new Set()
}

function toggleBlock(id: string) {
  const s = new Set(expandedBlocks.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedBlocks.value = s
}

function truncateText(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}...`
}

function formatToolInput(input: Record<string, any>): string {
  try { return JSON.stringify(input, null, 2) }
  catch { return String(input) }
}

function toolSummary(tc: ToolCall): string {
  const inp = tc.input
  if (inp.description) return truncateText(inp.description, 60)
  if (inp.command) return truncateText(inp.command, 60)
  if (inp.path) return inp.path.split('/').pop() ?? inp.path
  if (inp.query) return truncateText(inp.query, 60)
  if (inp.pattern) return truncateText(inp.pattern, 60)
  if (inp.glob_pattern) return truncateText(inp.glob_pattern, 60)
  if (inp.search_term) return truncateText(inp.search_term, 60)
  return ''
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const providerLabel: Record<string, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude',
  codex: 'Codex',
}

function sessionProviderLabel(provider: string): string {
  return providerLabel[provider] ?? provider
}

// ── Terminal panel (multi-tab) ──

interface TerminalTab {
  id: string
  label: string
  sessionId?: string
}

let terminalIdCounter = 0

const terminalTabs = ref<TerminalTab[]>([])
const activeTerminalId = ref<string | null>(null)
const showTerminal = ref(false)
const terminalHeight = ref(320)
const isDraggingResize = ref(false)
const terminalRefs = ref<Record<string, InstanceType<typeof CursorTerminal>>>({})

const repoLocalPath = computed(() =>
  reposStore.repos.find(r => r.id === repoId.value)?.local_path ?? '',
)

function setTerminalRef(id: string, el: any) {
  if (el) terminalRefs.value[id] = el
  else delete terminalRefs.value[id]
}

function addTerminalTab() {
  terminalIdCounter++
  const tab: TerminalTab = {
    id: `term-${terminalIdCounter}`,
    label: `Agent ${terminalIdCounter}`,
  }
  terminalTabs.value = [...terminalTabs.value, tab]
  activeTerminalId.value = tab.id
  if (!showTerminal.value) showTerminal.value = true
}

function closeTerminalTab(id: string) {
  const ref = terminalRefs.value[id]
  if (ref) {
    ref.dispose()
    delete terminalRefs.value[id]
  }
  terminalTabs.value = terminalTabs.value.filter(t => t.id !== id)
  if (activeTerminalId.value === id) {
    activeTerminalId.value = terminalTabs.value[terminalTabs.value.length - 1]?.id ?? null
  }
  if (terminalTabs.value.length === 0) {
    showTerminal.value = false
  }
}

function switchTerminalTab(id: string) {
  activeTerminalId.value = id
}

function resumeSession(session: SessionSummary) {
  terminalIdCounter++
  const shortId = session.sessionId.length > 8
    ? session.sessionId.slice(0, 8)
    : session.sessionId
  const tab: TerminalTab = {
    id: `term-${terminalIdCounter}`,
    label: `Resume ${shortId}`,
    sessionId: session.sessionId,
  }
  terminalTabs.value = [...terminalTabs.value, tab]
  activeTerminalId.value = tab.id
  showTerminal.value = true
}

function toggleTerminal() {
  if (showTerminal.value) {
    showTerminal.value = false
  }
  else if (terminalTabs.value.length > 0) {
    showTerminal.value = true
  }
  else {
    addTerminalTab()
  }
}

function onResizeStart(e: MouseEvent) {
  e.preventDefault()
  isDraggingResize.value = true
  const startY = e.clientY
  const startH = terminalHeight.value

  const onMove = (ev: MouseEvent) => {
    const delta = startY - ev.clientY
    terminalHeight.value = Math.max(150, Math.min(startH + delta, window.innerHeight - 200))
  }
  const onUp = () => {
    isDraggingResize.value = false
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// ── Lifecycle ──

let pollTimer: ReturnType<typeof setInterval> | null = null

function startPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => tasksStore.fetchByRepo(repoId.value), 5000)
}

async function loadRepoData() {
  closeSessionDetail()
  await Promise.all([
    tasksStore.fetchByRepo(repoId.value),
    loadSessions(true),
  ])
  startPolling()
}

onMounted(async () => {
  await Promise.all([
    requirementsStore.fetchAll(),
    reposStore.fetchAll(),
    rpc<{ stages: WorkflowStage[] }>('workflow.phases').then((res) => {
      if (res?.stages)
        workflowStages.value = res.stages
    }),
    rpc<{ workflows: WorkflowInfo[] }>('workflow.listAll').then((res) => {
      if (res?.workflows)
        availableWorkflows.value = res.workflows
    }),
  ])
  await loadRepoData()
})

watch(() => repoId.value, () => {
  loadRepoData()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function retryTask(taskId: string) {
  try {
    await tasksStore.retry(taskId)
    await tasksStore.fetchByRepo(repoId.value)

    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2000))
      await tasksStore.fetchByRepo(repoId.value)
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
    await tasksStore.fetchByRepo(repoId.value)
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header -->
    <div class="flex items-center gap-3 px-6 py-4 border-b border-gray-200 dark:border-white/5 bg-white/80 dark:bg-[#1e1e22]/80 backdrop-blur-sm">
      <button
        class="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        @click="router.push('/')"
      >
        <div class="i-carbon-arrow-left w-4 h-4 text-gray-400" />
      </button>
      <div class="flex-1 min-w-0">
        <h1 class="text-[15px] font-semibold tracking-tight">{{ repoName }}</h1>
        <p class="text-[12px] text-gray-400 mt-0.5">
          {{ activeTasks.length }} 个运行中 · {{ historyTasks.length }} 个已结束
        </p>
      </div>

      <button
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150"
        :class="showTerminal
          ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400'
          : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-white/5'"
        @click="toggleTerminal"
      >
        <div class="i-carbon-terminal w-3.5 h-3.5" />
        Cursor Agent
      </button>
    </div>

    <div class="flex-1 overflow-hidden flex flex-col">
      <div class="flex-1 min-h-0 flex gap-0">
      <!-- Left column: Pipeline (进行中 + 历史任务) -->
      <div class="flex-1 min-w-0 overflow-y-auto px-5 py-5 border-r border-gray-100 dark:border-white/[0.04]">
        <div class="flex items-center gap-2 mb-4">
          <div class="i-carbon-flow w-3.5 h-3.5 text-gray-400 opacity-60" />
          <h2 class="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">流水线</h2>
        </div>

        <div class="space-y-6">
          <!-- Pending tasks — workflow not yet selected -->
          <section v-if="pendingTasks.length > 0">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500" />
              <h3 class="text-[12px] font-semibold text-gray-600 dark:text-gray-300">未开始</h3>
              <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
                {{ pendingTasks.length }}
              </span>
            </div>

            <div class="space-y-2">
              <div
                v-for="task in pendingTasks"
                :key="task.id"
                class="group bg-white dark:bg-[#28282c] rounded-xl p-3.5 shadow-sm shadow-black/[0.04] dark:shadow-none border border-dashed border-gray-300 dark:border-gray-600 transition-all duration-150 cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md hover:shadow-indigo-500/[0.06]"
                @click="handleTaskClick(task)"
              >
                <div class="flex items-start gap-3">
                  <div class="mt-1 shrink-0 w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-500/10 flex items-center justify-center">
                    <div class="i-carbon-flow w-4 h-4 text-slate-400 dark:text-slate-500" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate mb-1">
                      {{ requirementTitle(task.requirement_id) }}
                    </p>
                    <div class="flex items-center gap-2">
                      <span class="text-[11px] text-slate-500 dark:text-slate-400">点击选择工作流</span>
                      <span class="text-[11px] text-gray-400 font-mono truncate">{{ task.branch_name }}</span>
                    </div>
                  </div>
                  <div class="i-carbon-play-filled w-4 h-4 text-indigo-500 shrink-0 mt-2 opacity-40 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            </div>
          </section>

          <!-- Active tasks -->
          <section v-if="activeTasks.length > 0">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
              <h3 class="text-[12px] font-semibold text-gray-600 dark:text-gray-300">进行中</h3>
              <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
                {{ activeTasks.length }}
              </span>
            </div>

            <div class="space-y-2">
              <div
                v-for="task in activeTasks"
                :key="task.id"
                class="group bg-white dark:bg-[#28282c] rounded-xl p-3.5 shadow-sm shadow-black/[0.04] dark:shadow-none border border-gray-100 dark:border-white/[0.04] transition-all duration-150 cursor-pointer hover:shadow-md hover:shadow-black/[0.06] hover:border-gray-200 dark:hover:border-white/[0.08]"
                @click="handleTaskClick(task)"
              >
                <div class="flex items-start gap-3">
                  <div class="mt-1.5 shrink-0">
                    <div
                      class="w-2.5 h-2.5 rounded-full"
                      :class="statusConfig[task.phase_status]?.dotClass ?? 'bg-gray-400'"
                    />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <p class="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate">
                        {{ requirementTitle(task.requirement_id) }}
                      </p>
                      <span
                        class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-medium"
                        :class="statusConfig[task.phase_status]?.badgeClass"
                      >
                        {{ stageNameMap[task.current_phase] ? `${stageNameMap[task.current_phase]} · ` : '' }}{{ phaseNameMap[task.current_phase] ?? task.current_phase }} · {{ statusConfig[task.phase_status]?.label ?? task.phase_status }}
                      </span>
                    </div>
                    <div class="flex items-center gap-3 text-[11px] text-gray-400">
                      <span class="font-mono truncate">{{ task.branch_name }}</span>
                      <span class="shrink-0 tabular-nums">{{ timeAgo(task.updated_at) }}</span>
                    </div>
                  </div>
                  <div class="i-carbon-chevron-right w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>

                <div
                  v-if="tasksStore.taskErrors[task.id]"
                  class="mt-2.5 ml-5.5 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/5 text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all"
                >
                  {{ tasksStore.taskErrors[task.id] }}
                </div>

                <div v-if="task.phase_status === 'failed'" class="mt-2.5 ml-5.5">
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-[12px] font-medium hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
                    :disabled="tasksStore.retrying.has(task.id)"
                    @click.stop="retryTask(task.id)"
                  >
                    <div
                      class="w-3.5 h-3.5"
                      :class="tasksStore.retrying.has(task.id) ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-restart'"
                    />
                    {{ tasksStore.retrying.has(task.id) ? '重试中...' : '重试当前阶段' }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- History tasks -->
          <section>
            <div class="flex items-center gap-2 mb-3">
              <div class="i-carbon-recently-viewed w-3.5 h-3.5 text-gray-400 opacity-60" />
              <h3 class="text-[12px] font-semibold text-gray-600 dark:text-gray-300">历史任务</h3>
              <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
                {{ historyTasks.length }}
              </span>
            </div>

            <div v-if="historyTasks.length > 0" class="rounded-xl border border-gray-100 dark:border-white/[0.04] overflow-hidden">
              <div
                v-for="(task, idx) in historyTasks"
                :key="task.id"
                class="group flex items-center gap-3 px-3.5 py-2.5 bg-white dark:bg-[#28282c] transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-white/[0.03]"
                :class="idx < historyTasks.length - 1 && 'border-b border-gray-100 dark:border-white/[0.04]'"
                @click="openTask(task.id)"
              >
                <div
                  class="w-2 h-2 rounded-full shrink-0"
                  :class="statusConfig[task.phase_status]?.dotClass ?? 'bg-gray-400'"
                />
                <p class="text-[12px] font-medium text-gray-700 dark:text-gray-200 truncate flex-1 min-w-0">
                  {{ requirementTitle(task.requirement_id) }}
                </p>
                <span
                  class="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-medium"
                  :class="statusConfig[task.phase_status]?.badgeClass"
                >
                  {{ statusConfig[task.phase_status]?.label ?? task.phase_status }}
                </span>
                <span class="shrink-0 text-[10px] text-gray-400 tabular-nums">
                  {{ formatDate(task.updated_at) }}
                </span>
                <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>

            <div
              v-else
              class="flex flex-col items-center justify-center py-12 text-gray-300 dark:text-gray-600"
            >
              <div class="i-carbon-recently-viewed w-8 h-8 mb-2 opacity-30" />
              <p class="text-[13px]">暂无历史任务</p>
            </div>
          </section>
        </div>
      </div>

      <!-- Right column: Agent Sessions -->
      <div
        class="flex-1 min-w-0 overflow-y-auto px-5 py-5"
        @scroll.passive="onSessionsScroll"
      >
        <div class="flex items-center gap-2 mb-4">
          <div class="i-carbon-data-base w-3.5 h-3.5 text-gray-400 opacity-60" />
          <h2 class="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Agent 会话</h2>
          <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
            {{ sessionsTotal > 0 ? `${sessions.length} / ${sessionsTotal}` : sessions.length }}
          </span>
          <button
            class="ml-auto p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
            title="刷新"
            @click="loadSessions(true)"
          >
            <div class="i-carbon-renew w-3.5 h-3.5 text-gray-400" :class="loadingSessions && 'animate-spin'" />
          </button>
        </div>

        <div v-if="loadingSessions && sessions.length === 0" class="flex items-center justify-center py-8 text-[12px] text-gray-400">
          <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
          扫描会话文件...
        </div>

        <div v-else-if="sessions.length > 0" class="space-y-3">
          <div
            v-for="session in sessions"
            :key="session.sessionId"
            class="group flex gap-3 p-4 bg-white dark:bg-[#28282c] rounded-xl border border-gray-100 dark:border-white/[0.04] transition-all cursor-pointer hover:shadow-md hover:shadow-black/[0.06] dark:hover:shadow-none hover:border-gray-200 dark:hover:border-white/[0.1]"
            @click="openSession(session)"
          >
            <div class="shrink-0 w-9 h-9 rounded-lg bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center">
              <div class="i-carbon-chat w-4 h-4 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-start gap-2">
                <p class="text-[13px] font-mono text-gray-800 dark:text-gray-100 truncate flex-1 min-w-0 leading-snug">
                  {{ session.sessionId }}
                </p>
                <div class="i-carbon-chevron-right w-4 h-4 text-gray-300 dark:text-gray-600 shrink-0 mt-0.5 opacity-40 group-hover:opacity-100 transition-opacity" />
              </div>
              <div class="mt-2.5">
                <p class="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-1">
                  首轮对话
                </p>
                <p
                  v-if="session.firstTurnPreview"
                  class="text-[12px] text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-3"
                >
                  {{ session.firstTurnPreview }}
                </p>
                <p
                  v-else
                  class="text-[12px] text-gray-400 dark:text-gray-600 italic"
                >
                  （无法从文件头解析首轮内容）
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-3 text-[11px] text-gray-500 dark:text-gray-500">
                <span class="px-2 py-0.5 rounded-md font-medium bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">
                  {{ sessionProviderLabel(session.provider) }}
                </span>
                <span class="tabular-nums">{{ formatFileSize(session.sizeBytes) }}</span>
                <span class="text-gray-400 dark:text-gray-600">·</span>
                <span class="tabular-nums text-gray-400 dark:text-gray-500">{{ formatDate(session.modifiedAt) }}</span>
                <span class="text-gray-400 dark:text-gray-600">·</span>
                <span class="tabular-nums text-gray-400 dark:text-gray-500">{{ timeAgo(session.modifiedAt) }}</span>
                <button
                  class="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-indigo-500 dark:text-indigo-400 opacity-0 group-hover:opacity-100 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-all"
                  title="恢复此对话"
                  @click.stop="resumeSession(session)"
                >
                  <div class="i-carbon-play w-3 h-3" />
                  恢复对话
                </button>
              </div>
            </div>
          </div>

          <div v-if="loadingMoreSessions" class="flex items-center justify-center py-3 text-[12px] text-gray-400">
            <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
            加载更多会话...
          </div>
          <button
            v-else-if="sessions.length < sessionsTotal"
            type="button"
            class="w-full py-2.5 rounded-lg text-[12px] text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors"
            @click="loadMoreSessions"
          >
            加载更多（{{ sessions.length }} / {{ sessionsTotal }}）
          </button>
        </div>

        <div
          v-else
          class="flex flex-col items-center justify-center py-12 text-gray-300 dark:text-gray-600"
        >
          <div class="i-carbon-data-base w-8 h-8 mb-2 opacity-30" />
          <p class="text-[13px]">未找到该仓库的 Agent 会话文件</p>
        </div>
      </div>
      </div>

      <!-- Terminal panel (multi-tab) -->
      <div
        v-if="showTerminal && repoLocalPath && terminalTabs.length > 0"
        class="shrink-0 border-t border-gray-200 dark:border-white/[0.06]"
        :style="{ height: `${terminalHeight}px` }"
      >
        <!-- Resize handle -->
        <div
          class="h-1 cursor-row-resize group flex items-center justify-center hover:bg-indigo-500/20 transition-colors"
          :class="isDraggingResize && 'bg-indigo-500/30'"
          @mousedown="onResizeStart"
        >
          <div class="w-8 h-0.5 rounded-full bg-gray-300 dark:bg-white/10 group-hover:bg-indigo-400 transition-colors" />
        </div>

        <!-- Tab bar -->
        <div class="flex items-center h-8 bg-[#1e1e22] border-b border-white/[0.06] px-1 gap-0.5 shrink-0 overflow-x-auto">
          <button
            v-for="tab in terminalTabs"
            :key="tab.id"
            class="group/tab flex items-center gap-1.5 px-2.5 h-6 rounded text-[11px] font-mono transition-all duration-100 shrink-0 max-w-[160px]"
            :class="activeTerminalId === tab.id
              ? 'bg-white/10 text-gray-200'
              : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'"
            @click="switchTerminalTab(tab.id)"
          >
            <div
              class="w-1.5 h-1.5 rounded-full shrink-0"
              :class="activeTerminalId === tab.id ? 'bg-emerald-500' : 'bg-gray-600'"
            />
            <span class="truncate">{{ tab.label }}</span>
            <div
              class="i-carbon-close w-3 h-3 shrink-0 opacity-0 group-hover/tab:opacity-70 hover:!opacity-100 transition-opacity"
              @click.stop="closeTerminalTab(tab.id)"
            />
          </button>

          <button
            class="flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors shrink-0 ml-0.5"
            title="新建终端"
            @click="addTerminalTab"
          >
            <div class="i-carbon-add w-3.5 h-3.5" />
          </button>
        </div>

        <!-- Terminal instances -->
        <div class="h-[calc(100%-4px-32px)] relative">
          <div
            v-for="tab in terminalTabs"
            :key="tab.id"
            class="absolute inset-0"
            :class="activeTerminalId === tab.id ? 'z-10 visible' : 'z-0 invisible'"
          >
            <CursorTerminal
              :ref="(el: any) => setTerminalRef(tab.id, el)"
              :repo-path="repoLocalPath"
              :visible="showTerminal && activeTerminalId === tab.id"
              :session-id="tab.sessionId"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Session detail modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showSessionDetail"
          class="fixed inset-0 z-50 flex"
        >
          <div class="absolute inset-0 bg-black/40 backdrop-blur-[2px]" @click="closeSessionDetail" />
          <div class="relative ml-auto w-full max-w-3xl h-full bg-white dark:bg-[#1e1e22] shadow-2xl flex flex-col">
            <!-- Modal header -->
            <div class="flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-white/5 shrink-0">
              <button
                class="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="closeSessionDetail"
              >
                <div class="i-carbon-close w-4 h-4 text-gray-400" />
              </button>
              <div class="flex-1 min-w-0">
                <h2 class="text-[14px] font-semibold truncate font-mono">
                  {{ selectedSession?.sessionId }}
                </h2>
                <div class="flex items-center gap-2 mt-0.5">
                  <span v-if="selectedSession?.provider" class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400">
                    {{ selectedSession.provider }}
                  </span>
                  <span v-if="transcriptFormat" class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400">
                    {{ transcriptFormat }}
                  </span>
                  <span v-if="transcriptTurns.length" class="text-[11px] text-gray-400">
                    {{ transcriptTurns.length }} 轮对话
                  </span>
                </div>
              </div>
            </div>

            <!-- Modal body -->
            <div class="flex-1 overflow-y-auto">
              <div v-if="loadingTranscript" class="flex items-center justify-center h-full text-[13px] text-gray-400">
                <div class="i-carbon-circle-dash w-5 h-5 animate-spin mr-2" />
                加载会话数据...
              </div>
              <div v-else-if="transcriptTurns.length > 0" class="p-4 space-y-4">
                <div
                  v-for="turn in transcriptTurns"
                  :key="turn.index"
                  class="turn-group"
                >
                  <!-- User message -->
                  <div v-if="turn.user_text" class="mb-3">
                    <div class="flex items-center gap-2 mb-1.5">
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
                        Turn {{ turn.index }}
                      </span>
                      <span v-if="turn.timestamp" class="text-[10px] text-gray-400 dark:text-gray-600 tabular-nums">
                        {{ turn.timestamp }}
                      </span>
                    </div>
                    <div class="rounded-xl px-4 py-3 bg-indigo-50/50 dark:bg-indigo-500/[0.04] border border-indigo-100 dark:border-indigo-500/10">
                      <div class="prose-chat text-[13px] leading-relaxed text-gray-700 dark:text-gray-200" v-html="md.render(turn.user_text)" />
                    </div>
                  </div>
                  <div v-else class="flex items-center gap-2 mb-2">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400">
                      Turn {{ turn.index }}
                    </span>
                  </div>

                  <!-- Assistant blocks -->
                  <div class="space-y-2 pl-3 border-l-2 border-emerald-200 dark:border-emerald-500/20">
                    <template v-for="(block, bIdx) in turn.blocks" :key="bIdx">
                      <!-- Text -->
                      <div v-if="block.kind === 'text'" class="rounded-xl px-4 py-3 bg-white dark:bg-[#28282c] border border-gray-100 dark:border-white/[0.04] shadow-sm shadow-black/[0.02] dark:shadow-none">
                        <div class="prose-chat text-[13px] leading-relaxed text-gray-700 dark:text-gray-200" v-html="md.render(block.text)" />
                      </div>

                      <!-- Thinking -->
                      <div v-else-if="block.kind === 'thinking'" class="rounded-lg overflow-hidden border border-purple-200/50 dark:border-purple-500/10">
                        <button
                          class="w-full flex items-center gap-2 px-3 py-2 text-left bg-purple-50/50 dark:bg-purple-500/[0.03] hover:bg-purple-50 dark:hover:bg-purple-500/5 transition-colors"
                          @click="toggleBlock(`think-${turn.index}-${bIdx}`)"
                        >
                          <div
                            class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150"
                            :class="expandedBlocks.has(`think-${turn.index}-${bIdx}`) && 'rotate-90'"
                          />
                          <div class="i-carbon-idea w-3.5 h-3.5 text-purple-500" />
                          <span class="text-[12px] font-medium text-purple-600 dark:text-purple-400">Thinking</span>
                          <span class="text-[11px] text-gray-400 dark:text-gray-500 truncate flex-1">
                            {{ truncateText(block.text, 80) }}
                          </span>
                        </button>
                        <div v-if="expandedBlocks.has(`think-${turn.index}-${bIdx}`)" class="px-4 py-3 bg-purple-50/30 dark:bg-purple-500/[0.02]">
                          <div class="prose-chat text-[12px] leading-relaxed text-gray-600 dark:text-gray-400" v-html="md.render(block.text)" />
                        </div>
                      </div>

                      <!-- Tool use -->
                      <div
                        v-else-if="block.kind === 'tool_use' && block.tool_call"
                        class="rounded-lg overflow-hidden border"
                        :class="block.tool_call.is_error
                          ? 'border-red-200 dark:border-red-500/15'
                          : 'border-gray-200 dark:border-white/[0.06]'"
                      >
                        <button
                          class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                          :class="block.tool_call.is_error
                            ? 'bg-red-50/50 dark:bg-red-500/[0.03] hover:bg-red-50 dark:hover:bg-red-500/5'
                            : 'bg-gray-50 dark:bg-[#1a1a1e] hover:bg-gray-100 dark:hover:bg-white/5'"
                          @click="toggleBlock(`tool-${turn.index}-${bIdx}`)"
                        >
                          <div
                            class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150"
                            :class="expandedBlocks.has(`tool-${turn.index}-${bIdx}`) && 'rotate-90'"
                          />
                          <div class="w-3.5 h-3.5" :class="block.tool_call.is_error ? 'i-carbon-warning-alt text-red-500' : 'i-carbon-terminal text-blue-500'" />
                          <span
                            class="text-[12px] font-medium"
                            :class="block.tool_call.is_error ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'"
                          >{{ block.tool_call.name }}</span>
                          <span class="text-[11px] text-gray-400 dark:text-gray-500 truncate flex-1 font-mono">
                            {{ toolSummary(block.tool_call) }}
                          </span>
                          <span v-if="block.tool_call.result !== null" class="shrink-0">
                            <div v-if="block.tool_call.is_error" class="i-carbon-close-filled w-3 h-3 text-red-400" />
                            <div v-else class="i-carbon-checkmark-filled w-3 h-3 text-emerald-400" />
                          </span>
                        </button>
                        <div v-if="expandedBlocks.has(`tool-${turn.index}-${bIdx}`)" class="border-t border-gray-100 dark:border-white/[0.04]">
                          <div class="px-3 py-2 bg-[#fafafa] dark:bg-[#161618]">
                            <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Input</div>
                            <pre class="text-[11px] font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">{{ formatToolInput(block.tool_call.input) }}</pre>
                          </div>
                          <div v-if="block.tool_call.result !== null" class="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04]" :class="block.tool_call.is_error ? 'bg-red-50/30 dark:bg-red-500/[0.02]' : 'bg-emerald-50/30 dark:bg-emerald-500/[0.02]'">
                            <div class="text-[10px] font-bold uppercase tracking-wider mb-1" :class="block.tool_call.is_error ? 'text-red-400' : 'text-emerald-500'">
                              {{ block.tool_call.is_error ? 'Error' : 'Result' }}
                            </div>
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

            <!-- Modal footer -->
            <div v-if="transcriptFilePath" class="shrink-0 px-5 py-2 border-t border-gray-100 dark:border-white/[0.03] text-[10px] font-mono text-gray-400 dark:text-gray-600 truncate">
              {{ transcriptFilePath }}
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Workflow selection dialog -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="showWorkflowPicker"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          @click.self="showWorkflowPicker = false"
        >
          <Transition
            appear
            enter-active-class="transition-all duration-200 ease-out"
            enter-from-class="opacity-0 scale-95 translate-y-2"
          >
            <div class="bg-white dark:bg-[#2c2c30] rounded-2xl shadow-2xl shadow-black/10 w-full max-w-md p-6">
              <div class="flex items-center gap-3 mb-5">
                <div class="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center shrink-0">
                  <div class="i-carbon-flow w-5 h-5 text-indigo-500" />
                </div>
                <div>
                  <h2 class="text-base font-semibold">选择工作流</h2>
                  <p class="text-[13px] text-gray-400 mt-0.5">选择一套工作流来驱动此任务的执行</p>
                </div>
              </div>

              <div class="space-y-2 max-h-64 overflow-y-auto mb-5">
                <label
                  v-for="wf in availableWorkflows"
                  :key="wf.id"
                  class="flex items-start gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all duration-150"
                  :class="selectedWorkflowId === wf.id
                    ? 'bg-indigo-50 dark:bg-indigo-500/10 border-2 border-indigo-400 dark:border-indigo-500/40'
                    : 'bg-gray-50 dark:bg-white/3 border-2 border-transparent hover:border-indigo-200 dark:hover:border-indigo-500/20'"
                  @click.prevent="selectedWorkflowId = wf.id"
                >
                  <input
                    type="radio"
                    :checked="selectedWorkflowId === wf.id"
                    class="mt-0.5 w-4 h-4 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer"
                  >
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-semibold text-gray-800 dark:text-gray-100">{{ wf.name }}</div>
                    <div v-if="wf.description" class="text-[12px] text-gray-400 mt-1 leading-relaxed line-clamp-2">{{ wf.description }}</div>
                  </div>
                </label>
              </div>

              <div v-if="availableWorkflows.length === 0" class="text-center py-8 text-gray-400">
                <div class="i-carbon-flow w-8 h-8 mx-auto mb-2 opacity-30" />
                <p class="text-[13px]">暂无可用工作流</p>
              </div>

              <div class="flex justify-end gap-2">
                <button
                  class="px-4 py-2 rounded-lg text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  @click="showWorkflowPicker = false"
                >
                  取消
                </button>
                <button
                  class="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="!selectedWorkflowId || startingWorkflow"
                  @click="confirmStartWithWorkflow"
                >
                  <div v-if="startingWorkflow" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
                  <div v-else class="i-carbon-play-filled w-4 h-4" />
                  {{ startingWorkflow ? '启动中...' : '启动工作流' }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style>
.prose-chat {
  font-size: 13px;
  line-height: 1.7;
}
.prose-chat p { margin: 0.4em 0; }
.prose-chat h1, .prose-chat h2, .prose-chat h3,
.prose-chat h4, .prose-chat h5, .prose-chat h6 {
  font-weight: 600;
  margin: 0.8em 0 0.3em;
  line-height: 1.3;
}
.prose-chat h1 { font-size: 1.25em; }
.prose-chat h2 { font-size: 1.15em; }
.prose-chat h3 { font-size: 1.05em; }
.prose-chat ul, .prose-chat ol {
  padding-left: 1.4em;
  margin: 0.4em 0;
}
.prose-chat li { margin: 0.15em 0; }
.prose-chat ul { list-style: disc; }
.prose-chat ol { list-style: decimal; }
.prose-chat code {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace;
  font-size: 0.9em;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: rgba(0,0,0,0.05);
}
:is(.dark) .prose-chat code {
  background: rgba(255,255,255,0.08);
}
.prose-chat pre {
  margin: 0.5em 0;
  padding: 0.75em 1em;
  border-radius: 8px;
  overflow-x: auto;
  background: #f5f5f7;
  font-size: 0.9em;
  line-height: 1.5;
}
:is(.dark) .prose-chat pre {
  background: #1e1e22;
}
.prose-chat pre code {
  padding: 0;
  background: transparent;
  font-size: inherit;
}
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
