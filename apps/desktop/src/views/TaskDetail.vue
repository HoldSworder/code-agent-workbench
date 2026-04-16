<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { rpc } from '../composables/use-sidecar'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const route = useRoute()
const router = useRouter()
const taskId = route.params.taskId as string
const repoId = route.params.repoId as string

const activeTab = ref<'chat' | 'files' | 'sessions'>('chat')

interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_stage: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
  workflow_id: string | null
  workflow_completed: number
  created_at: string
  updated_at: string
}

interface ChatMessage {
  id: string
  phase_id: string
  role: 'user' | 'assistant' | 'prompt' | 'system'
  content: string
  created_at: string
}

const task = ref<RepoTask | null>(null)
const messages = ref<ChatMessage[]>([])
const chatInput = ref('')
const chatInputEl = ref<HTMLTextAreaElement>()
const liveOutput = ref('')
const liveActivity = ref('')
const processExpanded = ref(false)
const activityScrollContainer = ref<HTMLElement>()
const chatContainer = ref<HTMLElement>()

// ── Workflow selection for pending tasks ──

interface WorkflowInfo {
  id: string
  name: string
  description: string
}

const availableWorkflows = ref<WorkflowInfo[]>([])
const selectedWorkflowId = ref('')
const startingWorkflow = ref(false)

const workflowJustStarted = ref(false)
const isPending = computed(() => task.value?.phase_status === 'pending' && !workflowJustStarted.value)

async function startWithWorkflow() {
  if (!task.value || !selectedWorkflowId.value) return
  startingWorkflow.value = true
  try {
    await rpc('workflow.start', {
      repoTaskId: task.value.id,
      workflowId: selectedWorkflowId.value,
    })
    await new Promise(r => setTimeout(r, 300))
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) {
      task.value = t
      viewingPhaseId.value = t.current_phase
    }
    const phasesRes = await rpc<{ stages: WorkflowStage[] }>('workflow.phases', { workflowId: selectedWorkflowId.value })
    if (phasesRes?.stages) workflowStages.value = phasesRes.stages
    await refreshMessages()
    if (t?.phase_status === 'running') startPolling()
  }
  catch (err) {
    console.error('Failed to start workflow:', err)
  }
  finally {
    startingWorkflow.value = false
  }
}

interface EntryInput {
  label: string
  description?: string
  placeholder?: string
}

interface WorkflowPhase {
  id: string
  name: string
  suspendable?: boolean
  optional?: boolean
  entryInput?: EntryInput
}

interface WorkflowStage {
  id: string
  name: string
  phases: WorkflowPhase[]
}

const workflowStages = ref<WorkflowStage[]>([])
const rollingBack = ref(false)
const viewingPhaseId = ref<string | null>(null)

const isViewingPastPhase = computed(() => {
  if (!task.value || !viewingPhaseId.value) return false
  return viewingPhaseId.value !== task.value.current_phase
})

const flatPhases = computed(() =>
  workflowStages.value.flatMap(stage =>
    stage.phases.map(phase => ({ ...phase, stageId: stage.id, stageName: stage.name })),
  ),
)

const statusLabel: Record<string, string> = {
  running: '运行中',
  waiting_input: '待反馈',
  waiting_confirm: '待确认',
  waiting_event: '等待事件',
  suspended: '已挂起',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  pending: '待启动',
}

const displayPhase = computed(() => {
  if (!task.value) return ''
  const phase = flatPhases.value.find(p => p.id === task.value!.current_phase)
  return phase?.name ?? task.value.current_phase
})

const displayStatus = computed(() =>
  task.value ? (statusLabel[task.value.phase_status] ?? task.value.phase_status) : '',
)

const isRunning = computed(() => task.value?.phase_status === 'running')

const currentPhaseSuspendable = computed(() => {
  if (!task.value) return false
  for (const stage of workflowStages.value) {
    const phase = stage.phases.find(p => p.id === task.value!.current_phase)
    if (phase) return !!phase.suspendable
  }
  return false
})

interface AdvanceOption {
  phaseId: string
  phaseName: string
  stageId: string
  entryInput?: EntryInput
}
interface PhaseProgress {
  status: 'in_progress' | 'ready' | 'blocked'
  step?: string
  stepName?: string
  reason?: string
}
interface AdvanceOptions {
  defaultNext: { phaseId: string, phaseName: string, stageId: string } | null
  optionalPhases: AdvanceOption[]
  blocked: boolean
  phaseProgress?: PhaseProgress
}

const advanceOptions = ref<AdvanceOptions | null>(null)
const advanceInputExpanded = ref(false)
const advanceInputText = ref('')

const hasOptionalAdvance = computed(() =>
  (advanceOptions.value?.optionalPhases.length ?? 0) > 0,
)

async function fetchAdvanceOptions() {
  if (!task.value) return
  const res = await rpc<AdvanceOptions>('workflow.getAdvanceOptions', { repoTaskId: task.value.id })
  advanceOptions.value = res ?? null
}

watch(
  () => task.value?.phase_status,
  (status) => {
    if (status === 'waiting_confirm' || status === 'waiting_input') {
      fetchAdvanceOptions()
    }
    else {
      advanceOptions.value = null
      advanceInputExpanded.value = false
      advanceInputText.value = ''
    }
  },
  { immediate: true },
)

const currentPhaseIndex = computed(() => {
  if (!task.value) return -1
  return flatPhases.value.findIndex(p => p.id === task.value!.current_phase)
})

function phaseState(index: number): 'done' | 'active' | 'future' {
  const ci = currentPhaseIndex.value
  if (ci === -1) return 'future'
  if (index < ci) return 'done'
  if (index === ci) return task.value?.phase_status === 'completed' ? 'done' : 'active'
  return 'future'
}

function getFlatIndex(stageIdx: number, phaseIdx: number): number {
  let idx = 0
  for (let s = 0; s < stageIdx; s++)
    idx += workflowStages.value[s].phases.length
  return idx + phaseIdx
}

interface PhaseGroup {
  phaseId: string
  phaseName: string
  stageName: string
  messages: ChatMessage[]
  state: 'done' | 'active' | 'future'
}

const messageGroups = computed<PhaseGroup[]>(() => {
  if (!flatPhases.value.length) return []

  const msgsByPhase = new Map<string, ChatMessage[]>()
  for (const msg of messages.value) {
    const arr = msgsByPhase.get(msg.phase_id) ?? []
    arr.push(msg)
    msgsByPhase.set(msg.phase_id, arr)
  }

  return flatPhases.value
    .map((phase, idx) => ({
      phaseId: phase.id,
      phaseName: phase.name,
      stageName: phase.stageName,
      messages: msgsByPhase.get(phase.id) ?? [],
      state: phaseState(idx),
    }))
    .filter(g => g.messages.length > 0 || g.state === 'active')
})

const hasAnyMessages = computed(() => messages.value.length > 0)

const phaseGroupEls = new Map<string, HTMLElement>()

function setPhaseGroupRef(phaseId: string) {
  return (el: Element | ComponentPublicInstance | null) => {
    if (el instanceof HTMLElement) phaseGroupEls.set(phaseId, el)
    else phaseGroupEls.delete(phaseId)
  }
}

const viewingStageId = ref<string | null>(null)

const currentStageId = computed(() => {
  if (!task.value) return null
  const phase = flatPhases.value.find(p => p.id === task.value!.current_phase)
  return phase?.stageId ?? task.value.current_stage ?? null
})

const viewingStagePhases = computed(() => {
  const sid = viewingStageId.value ?? currentStageId.value
  const stage = workflowStages.value.find(s => s.id === sid)
  return stage?.phases ?? []
})

function stageState(stageId: string): 'done' | 'active' | 'future' {
  const ci = currentPhaseIndex.value
  if (ci === -1) return 'future'
  const stagePhases = workflowStages.value.find(s => s.id === stageId)?.phases ?? []
  if (!stagePhases.length) return 'future'
  const firstIdx = flatPhases.value.findIndex(p => p.id === stagePhases[0].id)
  const lastIdx = flatPhases.value.findIndex(p => p.id === stagePhases[stagePhases.length - 1].id)
  if (ci > lastIdx) return 'done'
  if (ci >= firstIdx && ci <= lastIdx) {
    if (ci === lastIdx && task.value?.phase_status === 'completed') return 'done'
    return 'active'
  }
  return 'future'
}

function selectStage(stageId: string) {
  if (isRunning.value || rollingBack.value) return
  viewingStageId.value = stageId
}

function selectPhase(phaseId: string) {
  if (!task.value || rollingBack.value) return
  viewingPhaseId.value = phaseId
  const phase = flatPhases.value.find(p => p.id === phaseId)
  if (phase) viewingStageId.value = phase.stageId
  nextTick(() => {
    const el = phaseGroupEls.get(phaseId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function phaseIndexInStage(phaseId: string): number {
  const sid = viewingStageId.value ?? currentStageId.value
  const stage = workflowStages.value.find(s => s.id === sid)
  return stage?.phases.findIndex(p => p.id === phaseId) ?? -1
}

const viewingStageIdx = computed(() => {
  const sid = viewingStageId.value ?? currentStageId.value
  return workflowStages.value.findIndex(s => s.id === sid)
})

function viewingPhaseState(phaseIdx: number): 'done' | 'active' | 'future' {
  return phaseState(getFlatIndex(viewingStageIdx.value, phaseIdx))
}

interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

const changedFiles = ref<ChangedFile[]>([])
const selectedFilePath = ref<string | null>(null)
const fileDiff = ref('')
const loadingFiles = ref(false)
const loadingDiff = ref(false)

// ── Session transcript ──

interface AgentRun {
  id: string
  repo_task_id: string
  phase_id: string
  provider: string
  status: string
  started_at: string
  finished_at: string | null
  token_usage: number | null
  error: string | null
  session_id: string | null
  model: string | null
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

const agentRuns = ref<AgentRun[]>([])
const selectedRunId = ref<string | null>(null)
const transcriptTurns = ref<TranscriptTurn[]>([])
const transcriptFormat = ref('')
const transcriptFilePath = ref<string | null>(null)
const loadingRuns = ref(false)
const loadingTranscript = ref(false)
const expandedBlocks = ref<Set<string>>(new Set())

const agentProviderLabels: Record<string, string> = {
  'cursor-cli': 'Cursor CLI',
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'external-cli': 'CLI',
  'api': 'API',
}

const promptRunMap = computed<Map<string, AgentRun>>(() => {
  const map = new Map<string, AgentRun>()
  if (!agentRuns.value.length) return map
  const runsByPhase = new Map<string, AgentRun[]>()
  for (const run of agentRuns.value) {
    const arr = runsByPhase.get(run.phase_id) ?? []
    arr.push(run)
    runsByPhase.set(run.phase_id, arr)
  }
  for (const [, runs] of runsByPhase)
    runs.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())

  for (const msg of messages.value) {
    if (msg.role !== 'prompt') continue
    const phaseRuns = runsByPhase.get(msg.phase_id)
    if (!phaseRuns?.length) continue
    const msgTime = new Date(normalizeTime(msg.created_at)).getTime()
    let best = phaseRuns[0]
    let bestDiff = Infinity
    for (const run of phaseRuns) {
      const diff = Math.abs(new Date(normalizeTime(run.started_at)).getTime() - msgTime)
      if (diff < bestDiff) { bestDiff = diff; best = run }
    }
    map.set(msg.id, best)
  }
  return map
})

function findRunForPrompt(msg: ChatMessage): AgentRun | undefined {
  return promptRunMap.value.get(msg.id)
}

function normalizeTime(iso: string) {
  return iso.includes('T') || iso.includes('Z') ? iso : `${iso.replace(' ', 'T')}Z`
}

function formatTime(iso: string) {
  return new Date(normalizeTime(iso)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value)
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
  })
}

// ── 实时轮询 ──
let pollTimer: ReturnType<typeof setInterval> | null = null
const waitSeconds = ref(0)
let waitTimer: ReturnType<typeof setInterval> | null = null

async function pollLiveOutput() {
  if (!task.value) return
  try {
    const res = await rpc<{ output: string, activity: string }>('task.getLiveOutput', { repoTaskId: taskId })
    if (res?.output && res.output !== liveOutput.value) {
      liveOutput.value = res.output
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null }
      scrollToBottom()
    }
    if (res?.activity && res.activity !== liveActivity.value) {
      liveActivity.value = res.activity
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null }
    }
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) {
      const phaseChanged = task.value?.current_phase !== t.current_phase
      task.value = t
      if (phaseChanged) {
        viewingPhaseId.value = t.current_phase
        await Promise.all([refreshMessages(), loadAgentRuns()])
        liveOutput.value = ''
        liveActivity.value = ''
        processExpanded.value = false
      }
      if (t.phase_status !== 'running') {
        clearInterval(pollTimer!)
        pollTimer = null
        const [, phasesRes] = await Promise.all([
          Promise.all([refreshMessages(), loadAgentRuns()]),
          rpc<{ stages: WorkflowStage[] }>('workflow.phases', { workflowId: selectedWorkflowId.value || undefined }),
        ])
        if (phasesRes?.stages) workflowStages.value = phasesRes.stages
        liveOutput.value = ''
        liveActivity.value = ''
        processExpanded.value = false
      }
    }
  }
  catch { /* ignore polling errors */ }
}

function startPolling() {
  if (pollTimer) return
  waitSeconds.value = 0
  waitTimer = setInterval(() => { waitSeconds.value++ }, 1000)
  pollLiveOutput()
  pollTimer = setInterval(pollLiveOutput, 400)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (waitTimer) {
    clearInterval(waitTimer)
    waitTimer = null
  }
  waitSeconds.value = 0
  liveOutput.value = ''
  liveActivity.value = ''
  processExpanded.value = false
}

watch(isRunning, (running) => {
  if (running) startPolling()
  else stopPolling()
})

watch(liveActivity, () => {
  if (!processExpanded.value || !activityScrollContainer.value) return
  nextTick(() => {
    if (activityScrollContainer.value)
      activityScrollContainer.value.scrollTop = activityScrollContainer.value.scrollHeight
  })
})

watch(activeTab, (tab) => {
  if (tab === 'files') loadChangedFiles()
  if (tab === 'sessions') loadAgentRuns()
})

async function refreshMessages() {
  if (!task.value) return
  const msgs = await rpc<ChatMessage[]>('message.listAll', {
    taskId: task.value.id,
  })
  if (msgs) {
    messages.value = msgs
    scrollToBottom()
  }
}

onMounted(async () => {
  const startedWorkflowId = route.query.workflowId as string | undefined

  if (startedWorkflowId) {
    workflowJustStarted.value = true
    router.replace({ query: {} })
  }

  const [t, phasesRes, wfRes] = await Promise.all([
    rpc<RepoTask>('task.get', { id: taskId }),
    rpc<{ stages: WorkflowStage[] }>('workflow.phases', startedWorkflowId ? { workflowId: startedWorkflowId } : undefined),
    rpc<{ workflows: WorkflowInfo[] }>('workflow.listAll'),
  ])
  if (t) {
    task.value = t
    viewingPhaseId.value = t.current_phase
  }
  if (phasesRes?.stages) workflowStages.value = phasesRes.stages
  if (wfRes?.workflows) {
    availableWorkflows.value = wfRes.workflows
    selectedWorkflowId.value = wfRes.workflows[0]?.id ?? ''
  }

  if (startedWorkflowId && t?.phase_status === 'pending') {
    await new Promise(r => setTimeout(r, 500))
    const refreshed = await rpc<RepoTask>('task.get', { id: taskId })
    if (refreshed) {
      task.value = refreshed
      viewingPhaseId.value = refreshed.current_phase
    }
  }

  if (!isPending.value) {
    await Promise.all([refreshMessages(), loadAgentRuns(), loadInjectedTools()])
    if (isRunning.value) startPolling()
  }
})

onUnmounted(() => stopPolling())

async function loadChangedFiles() {
  if (!task.value) return
  loadingFiles.value = true
  try {
    const res = await rpc<{ files: ChangedFile[] }>('task.changedFiles', { repoTaskId: task.value.id })
    changedFiles.value = res?.files ?? []
  }
  catch { changedFiles.value = [] }
  finally { loadingFiles.value = false }
}

async function loadAgentRuns() {
  if (!task.value) return
  loadingRuns.value = true
  try {
    const runs = await rpc<AgentRun[]>('task.agentRuns', { repoTaskId: task.value.id })
    agentRuns.value = runs ?? []
  }
  catch { agentRuns.value = [] }
  finally { loadingRuns.value = false }
}

async function selectAgentRun(run: AgentRun) {
  if (selectedRunId.value === run.id) return
  selectedRunId.value = run.id
  transcriptTurns.value = []
  transcriptFilePath.value = null
  transcriptFormat.value = ''

  if (!run.session_id) return

  loadingTranscript.value = true
  try {
    const res = await rpc<{ turns: TranscriptTurn[], format: string, filePath: string | null }>(
      'task.sessionTranscript',
      { sessionId: run.session_id },
    )
    transcriptTurns.value = res?.turns ?? []
    transcriptFormat.value = res?.format ?? ''
    transcriptFilePath.value = res?.filePath ?? null
  }
  catch { transcriptTurns.value = [] }
  finally { loadingTranscript.value = false }
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

async function selectChangedFile(filePath: string) {
  if (selectedFilePath.value === filePath) return
  selectedFilePath.value = filePath
  loadingDiff.value = true
  try {
    const res = await rpc<{ diff: string }>('task.fileDiff', { repoTaskId: task.value!.id, filePath })
    fileDiff.value = res?.diff ?? ''
  }
  catch { fileDiff.value = '' }
  finally { loadingDiff.value = false }
}

function fileStatusColor(status: ChangedFile['status']) {
  return {
    added: 'text-emerald-500',
    modified: 'text-amber-500',
    deleted: 'text-red-500',
    renamed: 'text-blue-500',
  }[status]
}

function fileStatusLabel(status: ChangedFile['status']) {
  return { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[status]
}

function fileName(path: string) {
  return path.split('/').pop() ?? path
}

function fileDir(path: string) {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

async function sendMessage() {
  if (!chatInput.value.trim() || !task.value) return

  const content = chatInput.value.trim()
  chatInput.value = ''

  messages.value.push({
    id: `local-${Date.now()}`,
    phase_id: task.value.current_phase,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  })
  scrollToBottom()

  await rpc('workflow.feedback', {
    repoTaskId: task.value.id,
    feedback: content,
  })

  // 引擎是 fire-and-forget，给一点时间让状态更新到 running
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
  startPolling()
}

async function handleConfirm(advance = false) {
  if (!task.value) return
  await rpc('workflow.confirm', { repoTaskId: task.value.id, advance })
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
  if (advance) startPolling()
}

async function handleConfirmAndAdvance() {
  if (!task.value) return

  const content = '用户已确认，请实施方案并完成本阶段所有产出。'
  messages.value.push({
    id: `local-${Date.now()}`,
    phase_id: task.value.current_phase,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  })
  scrollToBottom()

  await rpc('workflow.confirmAndAdvance', { repoTaskId: task.value.id })
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
  startPolling()
}

async function handleContinuePhase() {
  if (!task.value) return

  const isBlocked = advanceOptions.value?.blocked
  const content = isBlocked
    ? '请继续完成本阶段剩余工作。'
    : '没有额外反馈，请继续执行。'
  messages.value.push({
    id: `local-${Date.now()}`,
    phase_id: task.value.current_phase,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  })
  scrollToBottom()

  await rpc('workflow.feedback', {
    repoTaskId: task.value.id,
    feedback: content,
  })
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
  startPolling()
}

async function handleConfirmAndAdvanceToPhase(targetPhaseId: string) {
  if (!task.value) return

  const input = advanceInputText.value.trim()
  const content = input || '用户已确认，请实施方案并完成本阶段所有产出。'
  messages.value.push({
    id: `local-${Date.now()}`,
    phase_id: targetPhaseId,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  })
  scrollToBottom()

  advanceInputExpanded.value = false
  advanceInputText.value = ''

  await rpc('workflow.confirmAndAdvanceToPhase', {
    repoTaskId: task.value.id,
    targetPhaseId,
    input: input || undefined,
  })
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
  startPolling()
}

async function handleSuspend() {
  if (!task.value) return
  await rpc('workflow.suspend', { repoTaskId: task.value.id })
  await new Promise(r => setTimeout(r, 500))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
}

async function handleResume() {
  if (!task.value) return
  await rpc('workflow.resume', { repoTaskId: task.value.id })
  await new Promise(r => setTimeout(r, 500))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
}

async function handleRollbackToMessage(messageId: string) {
  if (!task.value) return
  await rpc('workflow.rollbackToMessage', { repoTaskId: task.value.id, messageId })
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) {
    task.value = t
    viewingPhaseId.value = t.current_phase
  }
  await refreshMessages()
}

async function handleRetryFromPrompt(messageId: string) {
  if (!task.value || retryingPrompt.value) return
  retryingPrompt.value = messageId
  try {
    await rpc('workflow.retryFromPrompt', { repoTaskId: task.value.id, messageId })
    await new Promise(r => setTimeout(r, 300))
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) {
      task.value = t
      viewingPhaseId.value = t.current_phase
    }
    await refreshMessages()
    startPolling()
  }
  finally {
    retryingPrompt.value = null
  }
}

const composing = ref(false)
let compositionEndTimer: ReturnType<typeof setTimeout> | null = null

function onCompositionStart() {
  if (compositionEndTimer) { clearTimeout(compositionEndTimer); compositionEndTimer = null }
  composing.value = true
}

function onCompositionEnd() {
  compositionEndTimer = setTimeout(() => { composing.value = false }, 50)
}

function onKeydownEnter(e: KeyboardEvent) {
  if (e.isComposing || composing.value) return
  if (e.shiftKey) return
  e.preventDefault()
  sendMessage()
}

async function handleFeedback() {
  activeTab.value = 'chat'
  await nextTick()
  chatInputEl.value?.focus()
}

const expandedPrompts = ref<Set<string>>(new Set())
const retryingPrompt = ref<string | null>(null)

function togglePrompt(msgId: string) {
  const s = new Set(expandedPrompts.value)
  if (s.has(msgId)) s.delete(msgId)
  else s.add(msgId)
  expandedPrompts.value = s
}

const showPromptPreview = ref(false)
const promptPreviewContent = ref('')
const loadingPrompt = ref(false)

async function previewPhasePrompt() {
  const phaseId = viewingPhaseId.value ?? task.value?.current_phase
  if (!task.value || !phaseId) return
  loadingPrompt.value = true
  showPromptPreview.value = true
  try {
    const res = await rpc<{ prompt: string }>('workflow.previewPrompt', {
      repoTaskId: task.value.id,
      phaseId,
    })
    promptPreviewContent.value = res?.prompt ?? ''
  }
  catch (e: any) {
    promptPreviewContent.value = `加载失败: ${e.message ?? e}`
  }
  finally {
    loadingPrompt.value = false
  }
}

// ── Injected Tools ──

interface InjectedToolRef { id: string }

const injectedTools = ref<InjectedToolRef[]>([])
const showToolsPopover = ref(false)

async function loadInjectedTools() {
  const phaseId = viewingPhaseId.value ?? task.value?.current_phase
  if (!task.value || !phaseId) { injectedTools.value = []; return }
  try {
    const res = await rpc<InjectedToolRef[]>('workflow.getInjectedTools', {
      repoTaskId: task.value.id,
      phaseId,
    })
    injectedTools.value = res ?? []
  } catch {
    injectedTools.value = []
  }
}

watch(() => viewingPhaseId.value, () => loadInjectedTools())

const cancelling = ref(false)

async function handleAbort() {
  if (!task.value || cancelling.value) return
  cancelling.value = true
  try {
    await rpc('workflow.cancel', { repoTaskId: task.value.id })
    stopPolling()
    await new Promise(r => setTimeout(r, 300))
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) task.value = t
    await refreshMessages()
  }
  finally {
    cancelling.value = false
  }
}

const resetting = ref(false)
const showResetConfirm = ref(false)
const rollbackPauseMode = ref(true)

function requestReset() {
  if (!task.value || resetting.value) return
  rollbackPauseMode.value = true
  showResetConfirm.value = true
}

async function confirmReset() {
  showResetConfirm.value = false
  if (!task.value || resetting.value) return
  resetting.value = true
  try {
    if (isViewingPastPhase.value && viewingPhaseId.value) {
      rollingBack.value = true
      const targetPhase = flatPhases.value.find(p => p.id === viewingPhaseId.value)
      const rpcMethod = rollbackPauseMode.value ? 'workflow.rollbackPaused' : 'workflow.rollback'
      await rpc(rpcMethod, {
        repoTaskId: task.value.id,
        targetStageId: targetPhase?.stageId ?? task.value.current_stage,
        targetPhaseId: viewingPhaseId.value,
      })
    }
    else {
      await rpc('workflow.resetPhase', { repoTaskId: task.value.id })
    }
    liveOutput.value = ''
    liveActivity.value = ''
    processExpanded.value = false

    await new Promise(r => setTimeout(r, 300))
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) {
      task.value = t
      viewingPhaseId.value = t.current_phase
    }
    await refreshMessages()
    if (!rollbackPauseMode.value) startPolling()
  }
  finally {
    resetting.value = false
    rollingBack.value = false
  }
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk'
  content: string
  oldNum?: number
  newNum?: number
}

function parseDiffLines(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let oldN = 0
  let newN = 0

  for (const line of lines) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++'))
      continue

    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (m) { oldN = Number.parseInt(m[1], 10); newN = Number.parseInt(m[2], 10) }
      result.push({ type: 'hunk', content: line })
      continue
    }

    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), newNum: newN++ })
    }
    else if (line.startsWith('-')) {
      result.push({ type: 'del', content: line.slice(1), oldNum: oldN++ })
    }
    else if (line.startsWith(' ') || line === '') {
      result.push({ type: 'ctx', content: line.slice(1), oldNum: oldN++, newNum: newN++ })
    }
  }
  return result
}

async function handleCancel() {
  if (!task.value) return
  await rpc('workflow.cancel', { repoTaskId: task.value.id })
  router.push(`/repo/${repoId}`)
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header -->
    <div class="flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-white/5 bg-white/80 dark:bg-[#1e1e22]/80 backdrop-blur-sm">
      <button
        class="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        @click="router.push(`/repo/${repoId}`)"
      >
        <div class="i-carbon-arrow-left w-4 h-4 text-gray-400" />
      </button>

      <div v-if="task" class="flex-1 min-w-0 flex items-center gap-3">
        <div class="min-w-0">
          <h1 class="text-[14px] font-semibold truncate">{{ task.change_id }}</h1>
          <span class="text-[11px] text-gray-400 font-mono">{{ task.branch_name }}</span>
        </div>
        <span
          class="px-2 py-0.5 rounded-md text-[11px] font-medium shrink-0"
          :class="{
            'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400': task.phase_status === 'waiting_confirm',
            'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400': task.phase_status === 'waiting_input',
            'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400': task.phase_status === 'waiting_event',
            'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400': task.phase_status === 'failed',
            'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400': task.phase_status === 'running',
            'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400': task.phase_status === 'completed',
            'bg-gray-100 text-gray-600 dark:bg-gray-500/10 dark:text-gray-400': task.phase_status === 'suspended',
            'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-500': task.phase_status === 'cancelled',
            'bg-slate-100 text-slate-500 dark:bg-slate-500/10 dark:text-slate-400 border border-dashed border-slate-300 dark:border-slate-600': task.phase_status === 'pending',
          }"
        >
          <template v-if="task.phase_status === 'completed'">
            <div class="i-carbon-checkmark-filled w-3 h-3 inline-block mr-0.5 align-[-2px]" />
            全部完成
          </template>
          <template v-else-if="task.phase_status === 'pending'">
            待选择工作流
          </template>
          <template v-else>
            {{ displayPhase }} · {{ displayStatus }}
          </template>
        </span>
      </div>
      <div v-else class="flex-1 text-[13px] text-gray-400">加载中...</div>

      <!-- Reset / Rollback button -->
      <button
        v-if="task && !isRunning && !isPending"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
        :class="isViewingPastPhase
          ? 'text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-500/10'
          : 'text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'"
        :disabled="resetting || rollingBack"
        @click="requestReset"
      >
        <div class="w-3.5 h-3.5" :class="resetting || rollingBack ? 'i-carbon-circle-dash animate-spin' : isViewingPastPhase ? 'i-carbon-undo' : 'i-carbon-reset'" />
        {{ resetting || rollingBack ? '处理中...' : isViewingPastPhase ? '回滚到此阶段' : '重置' }}
      </button>

      <!-- Prompt preview button -->
      <button
        v-if="task && !isPending"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
        title="预览该阶段的 Agent 提示词"
        @click="previewPhasePrompt"
      >
        <div class="i-carbon-view w-3.5 h-3.5" />
        提示词
      </button>

      <!-- Injected tools badge -->
      <div v-if="injectedTools.length > 0 && !isPending" class="relative">
        <button
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors"
          title="当前阶段注入的工具"
          @click="showToolsPopover = !showToolsPopover"
        >
          <div class="i-carbon-tool-box w-3.5 h-3.5" />
          {{ injectedTools.length }} 工具
        </button>
        <div v-if="showToolsPopover" class="fixed inset-0 z-40" @click="showToolsPopover = false" />
        <Transition
          enter-active-class="transition-all duration-150 ease-out"
          leave-active-class="transition-all duration-100 ease-in"
          enter-from-class="opacity-0 scale-95"
          leave-to-class="opacity-0 scale-95"
        >
          <div
            v-if="showToolsPopover"
            class="absolute right-0 top-full mt-1 z-50 min-w-48 rounded-lg bg-white dark:bg-[#2c2c30] border border-gray-200 dark:border-white/10 shadow-lg shadow-black/10 dark:shadow-black/30 py-1.5"
          >
            <div class="px-3 py-1.5 text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
              已注入工具
            </div>
            <div v-for="t in injectedTools" :key="t.id" class="px-3 py-1.5 text-[12px] text-gray-700 dark:text-gray-300 flex items-center gap-2">
              <div class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
              {{ t.id }}
            </div>
          </div>
        </Transition>
      </div>

      <!-- Tab toggle -->
      <div v-if="!isPending" class="flex bg-gray-100 dark:bg-white/5 rounded-lg p-0.5">
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150"
          :class="activeTab === 'chat'
            ? 'bg-white dark:bg-[#2c2c30] text-gray-800 dark:text-gray-100 shadow-sm'
            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
          @click="activeTab = 'chat'"
        >
          <div class="i-carbon-chat w-3.5 h-3.5" />
          对话
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150"
          :class="activeTab === 'files'
            ? 'bg-white dark:bg-[#2c2c30] text-gray-800 dark:text-gray-100 shadow-sm'
            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
          @click="activeTab = 'files'"
        >
          <div class="i-carbon-document w-3.5 h-3.5" />
          文件
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all duration-150"
          :class="activeTab === 'sessions'
            ? 'bg-white dark:bg-[#2c2c30] text-gray-800 dark:text-gray-100 shadow-sm'
            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
          @click="activeTab = 'sessions'"
        >
          <div class="i-carbon-data-base w-3.5 h-3.5" />
          会话
        </button>
      </div>
    </div>

    <!-- Stage & Phase stepper (two rows) -->
    <div
      v-if="workflowStages.length > 0 && task && !isPending"
      class="border-b border-gray-100 dark:border-white/[0.03] bg-gray-50/50 dark:bg-[#1a1a1e]/50 py-3 px-5 space-y-2.5"
    >
      <!-- Row 1: Stage pills -->
      <div class="flex items-center gap-2">
        <template v-for="(stage, stageIdx) in workflowStages" :key="stage.id">
          <button
            class="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap transition-all duration-150"
            :class="{
              'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400': stageState(stage.id) === 'done',
              'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400': stageState(stage.id) === 'active',
              'text-gray-400 dark:text-gray-500': stageState(stage.id) === 'future',
              'ring-1 ring-indigo-400/30 dark:ring-indigo-500/20': (viewingStageId ?? currentStageId) === stage.id,
            }"
            @click="selectStage(stage.id)"
          >
            <div
              class="w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold transition-colors"
              :class="{
                'bg-emerald-500 text-white': stageState(stage.id) === 'done',
                'bg-indigo-500 text-white': stageState(stage.id) === 'active',
                'bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-gray-600': stageState(stage.id) === 'future',
              }"
            >
              <div v-if="stageState(stage.id) === 'done'" class="i-carbon-checkmark w-3 h-3" />
              <div v-else-if="stageState(stage.id) === 'active' && isRunning" class="i-carbon-circle-dash w-3 h-3 animate-spin" />
              <span v-else>{{ stageIdx + 1 }}</span>
            </div>
            {{ stage.name }}
          </button>
          <div
            v-if="stageIdx < workflowStages.length - 1"
            class="w-8 h-px shrink-0"
            :class="stageState(stage.id) === 'done' ? 'bg-emerald-300 dark:bg-emerald-500/30' : 'bg-gray-200 dark:bg-white/8'"
          />
        </template>
        <div v-if="rollingBack" class="ml-2 text-[11px] text-amber-500 animate-pulse">回滚中...</div>
      </div>

      <!-- Row 2: Phases in active/viewed stage -->
      <div class="flex items-center">
        <div class="w-1.5 h-1.5 rounded-full bg-indigo-400/50 mr-2 shrink-0 self-center" />
        <div class="flex items-center gap-1 overflow-x-auto min-w-0 flex-1 py-px px-px">
        <template v-for="(phase, phaseIdx) in viewingStagePhases" :key="phase.id">
          <button
            class="group flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all duration-150"
            :class="{
              'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 cursor-pointer': viewingPhaseState(phaseIdx) === 'done' && !isRunning,
              'text-indigo-600 dark:text-indigo-400 cursor-pointer': viewingPhaseState(phaseIdx) === 'active',
              'bg-indigo-50/80 dark:bg-indigo-500/10': viewingPhaseId === phase.id,
              'text-gray-300 dark:text-gray-600 cursor-default': viewingPhaseState(phaseIdx) === 'future',
              'pointer-events-none': isRunning || rollingBack,
              'ring-1 ring-indigo-400/40 dark:ring-indigo-500/25': viewingPhaseId === phase.id && viewingPhaseState(phaseIdx) !== 'future',
            }"
            :disabled="viewingPhaseState(phaseIdx) === 'future' || isRunning"
            @click="viewingPhaseState(phaseIdx) !== 'future' && selectPhase(phase.id)"
          >
            <div
              class="w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold transition-colors"
              :class="{
                'bg-emerald-500 text-white': viewingPhaseState(phaseIdx) === 'done',
                'bg-indigo-500 text-white': viewingPhaseState(phaseIdx) === 'active',
                'bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-gray-600': viewingPhaseState(phaseIdx) === 'future',
              }"
            >
              <div v-if="viewingPhaseState(phaseIdx) === 'done'" class="i-carbon-checkmark w-2.5 h-2.5" />
              <div v-else-if="viewingPhaseState(phaseIdx) === 'active' && isRunning" class="i-carbon-circle-dash w-2.5 h-2.5 animate-spin" />
              <span v-else>{{ phaseIdx + 1 }}</span>
            </div>
            {{ phase.name }}
          </button>
          <div
            v-if="phaseIdx < viewingStagePhases.length - 1"
            class="w-5 h-px mx-0.5 shrink-0"
            :class="viewingPhaseState(phaseIdx) === 'done' ? 'bg-emerald-300 dark:bg-emerald-500/30' : 'bg-gray-200 dark:bg-white/5'"
          />
        </template>
        </div>
      </div>
    </div>

    <!-- Content area -->
    <div class="flex-1 overflow-hidden">
      <!-- Pending: Workflow selection -->
      <div v-if="isPending" class="flex flex-col items-center justify-center h-full">
        <div class="w-full max-w-md px-6">
          <div class="flex flex-col items-center mb-8">
            <div class="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center mb-4">
              <div class="i-carbon-flow w-7 h-7 text-indigo-500" />
            </div>
            <h2 class="text-[16px] font-semibold text-gray-800 dark:text-gray-100 mb-1.5">选择工作流</h2>
            <p class="text-[13px] text-gray-400 text-center leading-relaxed">
              任务已创建，请选择一套工作流来驱动执行
            </p>
          </div>

          <div class="space-y-2 mb-6">
            <label
              v-for="wf in availableWorkflows"
              :key="wf.id"
              class="flex items-start gap-3 px-4 py-3.5 rounded-xl cursor-pointer transition-all duration-150"
              :class="selectedWorkflowId === wf.id
                ? 'bg-indigo-50 dark:bg-indigo-500/10 border-2 border-indigo-400 dark:border-indigo-500/40 shadow-sm shadow-indigo-500/10'
                : 'bg-white dark:bg-[#28282c] border-2 border-gray-100 dark:border-white/[0.06] hover:border-indigo-200 dark:hover:border-indigo-500/20'"
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

          <div v-if="availableWorkflows.length === 0" class="text-center py-8 text-gray-400 mb-6">
            <div class="i-carbon-flow w-8 h-8 mx-auto mb-2 opacity-30" />
            <p class="text-[13px]">暂无可用工作流</p>
          </div>

          <div class="flex justify-center gap-3">
            <button
              class="px-5 py-2.5 rounded-xl text-[13px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              @click="router.push(`/repo/${repoId}`)"
            >
              返回
            </button>
            <button
              class="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!selectedWorkflowId || startingWorkflow"
              @click="startWithWorkflow"
            >
              <div v-if="startingWorkflow" class="i-carbon-circle-dash w-4 h-4 animate-spin" />
              <div v-else class="i-carbon-play-filled w-4 h-4" />
              {{ startingWorkflow ? '启动中...' : '启动工作流' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Chat tab — full width -->
      <div v-show="activeTab === 'chat' && !isPending" class="flex flex-col h-full">
        <div ref="chatContainer" class="flex-1 overflow-y-auto px-6 py-4">
          <div class="max-w-5xl mx-auto space-y-3">
            <template v-for="group in messageGroups" :key="group.phaseId">
              <!-- Phase start divider -->
              <div :ref="setPhaseGroupRef(group.phaseId)" class="phase-divider flex items-center gap-2.5 py-4 max-w-[85%]">
                <div class="flex-1 h-px bg-gray-200 dark:bg-white/8" />
                <div
                  class="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium shrink-0"
                  :class="{
                    'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400': group.state === 'done',
                    'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400': group.state === 'active',
                  }"
                >
                  <div
                    class="w-3 h-3 rounded-full flex items-center justify-center shrink-0"
                    :class="{
                      'bg-emerald-500 text-white': group.state === 'done',
                      'bg-indigo-500 text-white': group.state === 'active',
                    }"
                  >
                    <div v-if="group.state === 'done'" class="i-carbon-checkmark w-2 h-2" />
                    <div v-else-if="group.state === 'active' && isRunning" class="i-carbon-circle-dash w-2 h-2 animate-spin" />
                    <div v-else class="w-1 h-1 rounded-full bg-white" />
                  </div>
                  <span class="text-[10px] text-gray-400 dark:text-gray-500 mr-1">{{ group.stageName }} ·</span>
                  {{ group.phaseName }}
                </div>
                <div class="flex-1 h-px bg-gray-200 dark:bg-white/8" />
              </div>

              <!-- Messages for this phase -->
              <template v-for="msg in group.messages" :key="msg.id">
                <!-- Prompt bubble (collapsible) -->
                <div v-if="msg.role === 'prompt'" class="max-w-[85%] group/prompt">
                  <div class="rounded-xl overflow-hidden border border-violet-200/60 dark:border-violet-500/15">
                    <button
                      class="w-full flex items-center gap-2 px-3 py-2 text-left bg-violet-50/50 dark:bg-violet-500/[0.04] hover:bg-violet-50 dark:hover:bg-violet-500/[0.06] transition-colors"
                      @click="togglePrompt(msg.id)"
                    >
                      <div
                        class="i-carbon-chevron-right w-3 h-3 text-gray-400 transition-transform duration-150"
                        :class="expandedPrompts.has(msg.id) && 'rotate-90'"
                      />
                      <div class="i-carbon-send-alt w-3.5 h-3.5 text-violet-500" />
                      <span class="text-[12px] font-medium text-violet-600 dark:text-violet-400">发送给 Agent 的提示词</span>
                      <!-- Agent / Model badge -->
                      <span v-if="findRunForPrompt(msg)" class="inline-flex items-center gap-1.5 shrink-0">
                        <span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-violet-100/60 dark:bg-violet-500/10 text-[10px] font-medium text-violet-500 dark:text-violet-400">
                          <div class="i-carbon-bot w-2.5 h-2.5" />
                          {{ agentProviderLabels[findRunForPrompt(msg)!.provider] ?? findRunForPrompt(msg)!.provider }}
                        </span>
                        <span v-if="findRunForPrompt(msg)!.model" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-violet-100/60 dark:bg-violet-500/10 text-[10px] font-mono text-violet-500 dark:text-violet-400 max-w-[140px] truncate">
                          <div class="i-carbon-machine-learning-model w-2.5 h-2.5 shrink-0" />
                          {{ findRunForPrompt(msg)!.model }}
                        </span>
                      </span>
                      <span class="text-[11px] text-gray-400 dark:text-gray-500 truncate flex-1">
                        {{ truncateText(msg.content.replace(/\n/g, ' '), 60) }}
                      </span>
                      <span class="text-[10px] text-gray-300 dark:text-gray-600 tabular-nums shrink-0">
                        {{ formatTime(msg.created_at) }}
                      </span>
                    </button>
                    <div
                      v-if="expandedPrompts.has(msg.id)"
                      class="px-4 py-3 bg-violet-50/30 dark:bg-violet-500/[0.02] border-t border-violet-200/40 dark:border-violet-500/10 max-h-96 overflow-y-auto"
                    >
                      <div class="prose-chat text-[12px] leading-relaxed text-gray-600 dark:text-gray-400" v-html="md.render(msg.content)" />
                    </div>
                  </div>
                  <button
                    v-if="!isRunning && !isPending"
                    class="mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-gray-400 dark:text-gray-500 opacity-0 group-hover/prompt:opacity-100 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-all"
                    :disabled="retryingPrompt === msg.id"
                    @click="handleRetryFromPrompt(msg.id)"
                  >
                    <div class="w-3 h-3" :class="retryingPrompt === msg.id ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-restart'" />
                    {{ retryingPrompt === msg.id ? '重试中...' : '重试' }}
                  </button>
                </div>

                <!-- System notification bubble -->
                <div v-else-if="msg.role === 'system'" class="max-w-[85%]">
                  <div class="flex justify-center">
                    <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-50 dark:bg-amber-500/[0.06] border border-amber-200/50 dark:border-amber-500/15">
                      <div class="i-carbon-warning-alt w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span class="text-[12px] text-amber-700 dark:text-amber-400">{{ msg.content }}</span>
                      <span class="text-[10px] text-amber-400/60 dark:text-amber-500/40 tabular-nums shrink-0">{{ formatTime(msg.created_at) }}</span>
                    </div>
                  </div>
                </div>

                <!-- User / Assistant bubbles -->
                <div
                  v-else
                  class="flex group/msg"
                  :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
                >
                  <div class="flex flex-col max-w-[85%] min-w-0">
                    <div
                      class="rounded-2xl px-4 py-3 text-[13px] leading-relaxed overflow-hidden"
                      :class="msg.role === 'user'
                        ? 'bg-indigo-600 text-white rounded-br-md'
                        : 'bg-white dark:bg-[#28282c] text-gray-700 dark:text-gray-200 rounded-bl-md shadow-sm shadow-black/[0.04] dark:shadow-none'"
                    >
                      <div
                        v-if="msg.role === 'assistant'"
                        class="prose-chat"
                        v-html="md.render(msg.content)"
                      />
                      <p v-else class="whitespace-pre-wrap">{{ msg.content }}</p>
                      <div
                        class="text-[11px] mt-1.5 text-right tabular-nums"
                        :class="msg.role === 'user' ? 'text-indigo-300' : 'text-gray-300 dark:text-gray-600'"
                      >
                        {{ formatTime(msg.created_at) }}
                      </div>
                    </div>
                    <button
                      v-if="!isRunning && !isPending && msg.role !== 'prompt'"
                      class="self-end mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-gray-400 dark:text-gray-500 opacity-0 group-hover/msg:opacity-100 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-all"
                      @click="handleRollbackToMessage(msg.id)"
                    >
                      <div class="i-carbon-undo w-3 h-3" />
                      回滚到此处
                    </button>
                  </div>
                </div>
              </template>

              <!-- Live streaming: process bubble + text bubble (current phase only) -->
              <template v-if="group.state === 'active'">
                <!-- Process bubble (collapsible activity log) -->
                <div v-if="liveActivity" class="flex justify-start">
                  <div class="max-w-[85%] min-w-0 rounded-2xl rounded-bl-md overflow-hidden shadow-sm shadow-black/[0.04] dark:shadow-none">
                    <!-- Collapsed: status bar -->
                    <div
                      class="flex items-center justify-between px-4 py-2.5 bg-gray-100/80 dark:bg-[#1e1e22] cursor-pointer select-none transition-colors hover:bg-gray-200/60 dark:hover:bg-[#252528]"
                      @click="processExpanded = !processExpanded"
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                        <span class="text-[12px] text-gray-500 dark:text-gray-400 truncate">
                          {{ liveActivity.trim().split('\n').pop()?.slice(0, 60) || 'Agent 工作中...' }}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 shrink-0 ml-3">
                        <span class="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
                          {{ liveActivity.trim().split('\n').length }} 条
                        </span>
                        <div
                          class="w-4 h-4 transition-transform duration-200"
                          :class="[processExpanded ? 'i-carbon-chevron-up' : 'i-carbon-chevron-down', 'text-gray-400']"
                        />
                      </div>
                    </div>
                    <!-- Expanded: terminal panel -->
                    <div
                      v-if="processExpanded"
                      ref="activityScrollContainer"
                      class="overflow-y-auto font-mono text-[11px] leading-relaxed px-4 py-3 bg-gray-900 text-gray-300 whitespace-pre-wrap break-all"
                      style="max-height: 300px;"
                    >{{ liveActivity }}</div>
                  </div>
                </div>

                <!-- Text streaming bubble -->
                <div v-if="liveOutput" class="flex justify-start">
                  <div class="max-w-[85%] min-w-0 rounded-2xl rounded-bl-md px-4 py-3 bg-white dark:bg-[#28282c] shadow-sm shadow-black/[0.04] dark:shadow-none overflow-hidden">
                    <div
                      class="prose-chat text-[13px] text-gray-700 dark:text-gray-200 leading-relaxed"
                      v-html="md.render(liveOutput)"
                    />
                    <div class="flex items-center gap-1.5 mt-2 text-[11px] text-indigo-500 dark:text-indigo-400">
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                      正在输出...
                    </div>
                  </div>
                </div>

                <!-- Startup indicator (no activity and no output yet) -->
                <div v-else-if="isRunning && !liveOutput && !liveActivity" class="flex justify-start">
                  <div class="flex items-center gap-2 px-4 py-3 rounded-2xl rounded-bl-md bg-white dark:bg-[#28282c] shadow-sm shadow-black/[0.04] dark:shadow-none">
                    <div class="flex gap-1">
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style="animation-delay: 0ms" />
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style="animation-delay: 150ms" />
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style="animation-delay: 300ms" />
                    </div>
                    <span class="text-[12px] text-gray-400">Agent 正在启动...{{ waitSeconds > 5 ? ` (${waitSeconds}s)` : '' }}</span>
                  </div>
                </div>
              </template>

              <!-- Inline action card for waiting_input phase (blocked: simplified, normal: full) -->
              <div
                v-if="task?.phase_status === 'waiting_input' && task.current_phase === group.phaseId && advanceOptions?.blocked"
                class="rounded-xl border border-orange-200/60 dark:border-orange-500/15 bg-orange-50/50 dark:bg-orange-500/[0.04] px-4 py-3 max-w-[85%]"
              >
                <div class="flex items-center gap-2 mb-1">
                  <div class="i-carbon-in-progress w-4 h-4 text-orange-500" />
                  <span class="text-[13px] text-orange-700 dark:text-orange-400 font-medium">
                    {{ displayPhase }}
                    <template v-if="advanceOptions?.phaseProgress?.step">
                      ({{ advanceOptions.phaseProgress.step }})
                    </template>
                    {{ advanceOptions?.phaseProgress?.stepName ?? '完成条件未满足，可继续完成或输入反馈' }}
                  </span>
                </div>
                <p
                  v-if="advanceOptions?.phaseProgress?.reason"
                  class="text-[11px] text-orange-600/70 dark:text-orange-400/60 ml-6 mb-2"
                >
                  {{ advanceOptions.phaseProgress.reason }}
                </p>
                <div class="flex items-center gap-2 justify-end">
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-500 hover:bg-white/80 dark:hover:bg-white/5 transition-colors"
                    @click="handleCancel"
                  >
                    取消任务
                  </button>
                  <button
                    v-if="currentPhaseSuspendable"
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-600/30 hover:bg-gray-100/50 dark:hover:bg-gray-500/10 transition-colors"
                    @click="handleSuspend"
                  >
                    挂起需求
                  </button>
                  <button
                    class="px-4 py-1.5 rounded-lg bg-orange-500 text-white text-[12px] font-medium hover:bg-orange-400 shadow-sm shadow-orange-500/20 transition-all duration-150 active:scale-[0.97]"
                    @click="handleContinuePhase"
                  >
                    继续完成本阶段
                  </button>
                </div>
              </div>
              <div
                v-if="task?.phase_status === 'waiting_input' && task.current_phase === group.phaseId && !advanceOptions?.blocked"
                class="rounded-xl border border-orange-200/60 dark:border-orange-500/15 bg-orange-50/50 dark:bg-orange-500/[0.04] px-4 py-3 max-w-[85%]"
              >
                <div class="flex items-center gap-2 mb-3">
                  <div class="i-carbon-chat w-4 h-4 text-orange-500" />
                  <span class="text-[13px] text-orange-700 dark:text-orange-400 font-medium">
                    {{ displayPhase }} 等待你的反馈后继续执行
                  </span>
                </div>

                <!-- Optional phase advance input -->
                <template v-if="hasOptionalAdvance">
                  <div
                    v-for="opt in advanceOptions!.optionalPhases"
                    :key="opt.phaseId"
                    class="mb-3"
                  >
                    <button
                      class="flex items-center gap-1.5 text-[12px] text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300 transition-colors"
                      @click="advanceInputExpanded = !advanceInputExpanded"
                    >
                      <div
                        class="w-3.5 h-3.5 transition-transform"
                        :class="advanceInputExpanded ? 'i-carbon-chevron-down' : 'i-carbon-chevron-right'"
                      />
                      {{ opt.entryInput?.label || opt.phaseName }}（可选）
                    </button>
                    <p v-if="opt.entryInput?.description && advanceInputExpanded" class="text-[11px] text-gray-500 dark:text-gray-400 mt-1 ml-5">
                      {{ opt.entryInput.description }}
                    </p>
                    <div v-if="advanceInputExpanded" class="mt-2 ml-5">
                      <textarea
                        v-model="advanceInputText"
                        :placeholder="opt.entryInput?.placeholder || '请输入...'"
                        class="w-full min-h-[100px] max-h-[300px] p-2.5 rounded-lg text-[12px] bg-white dark:bg-[#1e1e22] border border-orange-200/60 dark:border-orange-500/15 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 resize-y focus:outline-none focus:ring-1 focus:ring-orange-400/50"
                      />
                      <div class="flex items-center gap-2 justify-end mt-2">
                        <button
                          class="px-3 py-1.5 rounded-lg text-[12px] text-gray-500 hover:bg-white/80 dark:hover:bg-white/5 transition-colors"
                          @click="advanceInputExpanded = false; advanceInputText = ''"
                        >
                          收起
                        </button>
                        <button
                          :disabled="!advanceInputText.trim()"
                          class="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
                          :class="advanceInputText.trim()
                            ? 'bg-orange-500 text-white hover:bg-orange-400 shadow-sm shadow-orange-500/20'
                            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'"
                          @click="handleConfirmAndAdvanceToPhase(opt.phaseId)"
                        >
                          确认并开始{{ opt.phaseName }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>

                <div class="flex items-center gap-2 justify-end">
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-500 hover:bg-white/80 dark:hover:bg-white/5 transition-colors"
                    @click="handleCancel"
                  >
                    取消任务
                  </button>
                  <button
                    v-if="currentPhaseSuspendable"
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-600/30 hover:bg-gray-100/50 dark:hover:bg-gray-500/10 transition-colors"
                    @click="handleSuspend"
                  >
                    挂起需求
                  </button>
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-500/20 hover:bg-orange-100/50 dark:hover:bg-orange-500/10 transition-colors"
                    @click="handleContinuePhase"
                  >
                    继续执行
                  </button>
                  <button
                    class="px-4 py-1.5 rounded-lg bg-orange-500 text-white text-[12px] font-medium hover:bg-orange-400 shadow-sm shadow-orange-500/20 transition-all duration-150 active:scale-[0.97]"
                    @click="handleConfirmAndAdvance"
                  >
                    {{ hasOptionalAdvance && advanceOptions?.defaultNext ? `跳过，进入${advanceOptions.defaultNext.phaseName}` : '确认并进入下一阶段' }}
                  </button>
                </div>
              </div>

              <!-- Inline confirm card (once per group, only for current phase in waiting_confirm) -->
              <div
                v-if="task?.phase_status === 'waiting_confirm' && task.current_phase === group.phaseId"
                class="rounded-xl border border-amber-200/60 dark:border-amber-500/15 bg-amber-50/50 dark:bg-amber-500/[0.04] px-4 py-3 max-w-[85%]"
              >
                <div class="flex items-center gap-2 mb-3">
                  <div class="i-carbon-task-complete w-4 h-4 text-amber-500" />
                  <span class="text-[13px] text-amber-700 dark:text-amber-400 font-medium">
                    {{ displayPhase }} 产出已就绪，请确认后继续推进
                  </span>
                </div>

                <!-- Optional phase advance input (e.g. integration) -->
                <template v-if="hasOptionalAdvance">
                  <div
                    v-for="opt in advanceOptions!.optionalPhases"
                    :key="opt.phaseId"
                    class="mb-3"
                  >
                    <button
                      class="flex items-center gap-1.5 text-[12px] text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
                      @click="advanceInputExpanded = !advanceInputExpanded"
                    >
                      <div
                        class="w-3.5 h-3.5 transition-transform"
                        :class="advanceInputExpanded ? 'i-carbon-chevron-down' : 'i-carbon-chevron-right'"
                      />
                      {{ opt.entryInput?.label || opt.phaseName }}（可选）
                    </button>
                    <p v-if="opt.entryInput?.description && advanceInputExpanded" class="text-[11px] text-gray-500 dark:text-gray-400 mt-1 ml-5">
                      {{ opt.entryInput.description }}
                    </p>
                    <div v-if="advanceInputExpanded" class="mt-2 ml-5">
                      <textarea
                        v-model="advanceInputText"
                        :placeholder="opt.entryInput?.placeholder || '请输入...'"
                        class="w-full min-h-[100px] max-h-[300px] p-2.5 rounded-lg text-[12px] bg-white dark:bg-[#1e1e22] border border-amber-200/60 dark:border-amber-500/15 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-500 resize-y focus:outline-none focus:ring-1 focus:ring-amber-400/50"
                      />
                      <div class="flex items-center gap-2 justify-end mt-2">
                        <button
                          class="px-3 py-1.5 rounded-lg text-[12px] text-gray-500 hover:bg-white/80 dark:hover:bg-white/5 transition-colors"
                          @click="advanceInputExpanded = false; advanceInputText = ''"
                        >
                          收起
                        </button>
                        <button
                          :disabled="!advanceInputText.trim()"
                          class="px-4 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-150 active:scale-[0.97]"
                          :class="advanceInputText.trim()
                            ? 'bg-amber-500 text-white hover:bg-amber-400 shadow-sm shadow-amber-500/20'
                            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'"
                          @click="handleConfirmAndAdvanceToPhase(opt.phaseId)"
                        >
                          确认并开始{{ opt.phaseName }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>

                <div class="flex items-center gap-2 justify-end">
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-500 hover:bg-white/80 dark:hover:bg-white/5 transition-colors"
                    @click="handleCancel"
                  >
                    取消任务
                  </button>
                  <button
                    v-if="currentPhaseSuspendable"
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-600/30 hover:bg-gray-100/50 dark:hover:bg-gray-500/10 transition-colors"
                    @click="handleSuspend"
                  >
                    挂起需求
                  </button>
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/20 hover:bg-amber-100/50 dark:hover:bg-amber-500/10 transition-colors"
                    @click="handleFeedback"
                  >
                    反馈修改
                  </button>
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/20 hover:bg-amber-100/50 dark:hover:bg-amber-500/10 transition-colors"
                    @click="handleConfirm(false)"
                  >
                    确认通过
                  </button>
                  <button
                    class="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-[12px] font-medium hover:bg-amber-400 shadow-sm shadow-amber-500/20 transition-all duration-150 active:scale-[0.97]"
                    @click="handleConfirmAndAdvance"
                  >
                    {{ hasOptionalAdvance && advanceOptions?.defaultNext ? `跳过，进入${advanceOptions.defaultNext.phaseName}` : '确认通过并进入下一阶段' }}
                  </button>
                </div>
              </div>

              <!-- Inline suspended card -->
              <div
                v-if="task?.phase_status === 'suspended' && task.current_phase === group.phaseId"
                class="rounded-xl border border-gray-200/60 dark:border-gray-600/20 bg-gray-50/50 dark:bg-gray-500/[0.04] px-4 py-3 max-w-[85%]"
              >
                <div class="flex items-center gap-2 mb-3">
                  <div class="i-carbon-pause-filled w-4 h-4 text-gray-400" />
                  <span class="text-[13px] text-gray-600 dark:text-gray-400 font-medium">
                    需求已挂起，等待外部依赖就绪后继续
                  </span>
                </div>
                <div class="flex items-center gap-2 justify-end">
                  <button
                    class="px-3 py-1.5 rounded-lg text-[12px] text-gray-500 hover:bg-white/80 dark:hover:bg-white/5 transition-colors"
                    @click="handleCancel"
                  >
                    取消任务
                  </button>
                  <button
                    class="px-4 py-1.5 rounded-lg bg-indigo-500 text-white text-[12px] font-medium hover:bg-indigo-400 shadow-sm shadow-indigo-500/20 transition-all duration-150 active:scale-[0.97]"
                    @click="handleResume"
                  >
                    恢复并继续
                  </button>
                </div>
              </div>

              <!-- Phase end divider (completed phases only) -->
              <div v-if="group.state === 'done'" class="flex items-center gap-2.5 py-3 max-w-[85%]">
                <div class="flex-1 h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-white/6 to-transparent" />
                <span class="text-[10px] text-gray-300 dark:text-gray-500 flex items-center gap-1 shrink-0">
                  <div class="i-carbon-checkmark-filled w-2.5 h-2.5 text-emerald-400/50 dark:text-emerald-500/30" />
                  {{ group.phaseName }} 完成
                </span>
                <div class="flex-1 h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-white/6 to-transparent" />
              </div>
            </template>

            <!-- Empty state -->
            <div
              v-if="!hasAnyMessages && !liveOutput && !liveActivity && !isRunning"
              class="flex items-center justify-center py-20 text-gray-300 dark:text-gray-600 text-[13px]"
            >
              <div class="text-center">
                <div class="i-carbon-chat w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>暂无对话记录</p>
              </div>
            </div>

            <!-- Workflow completed hint -->
            <div
              v-if="task && (task.phase_status === 'completed' || task.phase_status === 'waiting_event') && hasAnyMessages"
              class="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-50/60 dark:bg-emerald-500/[0.06] border border-emerald-200/40 dark:border-emerald-500/10 text-[12px] text-emerald-600 dark:text-emerald-400"
            >
              <div class="i-carbon-checkmark-outline w-4 h-4 shrink-0" />
              <span>工作流已完成所有阶段，你可以继续输入指令对当前阶段进行追加操作。</span>
            </div>
          </div>
        </div>

        <!-- Input bar -->
        <div class="border-t border-gray-200 dark:border-white/5 p-4 bg-white/60 dark:bg-[#1e1e22]/60 backdrop-blur-sm">
          <div class="max-w-5xl mx-auto flex items-end gap-2">
            <textarea
              ref="chatInputEl"
              v-model="chatInput"
              rows="1"
              placeholder="输入反馈或指令..."
              class="flex-1 px-4 py-2.5 rounded-xl bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors resize-none leading-relaxed max-h-[160px]"
              style="field-sizing: content"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
              @keydown.enter="onKeydownEnter"
            />
            <button
              v-if="isRunning"
              class="px-4 py-2.5 rounded-xl bg-red-500 text-white text-[13px] font-medium hover:bg-red-400 shadow-sm shadow-red-500/20 transition-all duration-150 active:scale-[0.97] disabled:opacity-50"
              :disabled="cancelling"
              @click="handleAbort"
            >
              <div class="w-4 h-4" :class="cancelling ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-stop-filled'" />
            </button>
            <button
              v-else
              class="px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-[13px] font-medium hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 transition-all duration-150 active:scale-[0.97]"
              @click="sendMessage"
            >
              <div class="i-carbon-send w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <!-- Sessions tab — agent runs + transcript (Turn-based, inspired by claude-replay) -->
      <div v-show="activeTab === 'sessions' && !isPending" class="flex h-full">
        <!-- Run list sidebar -->
        <div class="w-72 border-r border-gray-200 dark:border-white/5 overflow-y-auto bg-[#fafafa] dark:bg-[#1e1e22] flex flex-col">
          <div class="px-3 py-2.5 border-b border-gray-100 dark:border-white/[0.03] flex items-center justify-between">
            <span class="text-[12px] font-medium text-gray-500 dark:text-gray-400">
              Agent 会话
              <span v-if="agentRuns.length" class="ml-1 text-gray-400 dark:text-gray-500">({{ agentRuns.length }})</span>
            </span>
            <button
              class="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              title="刷新"
              @click="loadAgentRuns"
            >
              <div class="i-carbon-renew w-3.5 h-3.5 text-gray-400" :class="loadingRuns && 'animate-spin'" />
            </button>
          </div>

          <div class="flex-1 overflow-y-auto py-1">
            <div v-if="loadingRuns" class="flex items-center justify-center h-20 text-[12px] text-gray-400">
              <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
              加载中...
            </div>
            <div
              v-else-if="agentRuns.length === 0"
              class="flex flex-col items-center justify-center h-32 text-[12px] text-gray-300 dark:text-gray-600"
            >
              <div class="i-carbon-data-base w-8 h-8 mb-2 opacity-30" />
              暂无会话记录
            </div>
            <button
              v-for="run in agentRuns"
              :key="run.id"
              class="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              :class="selectedRunId === run.id && 'bg-indigo-50 dark:bg-indigo-500/10'"
              @click="selectAgentRun(run)"
            >
              <div
                class="shrink-0 w-2 h-2 mt-1.5 rounded-full"
                :class="{
                  'bg-emerald-500': run.status === 'success',
                  'bg-red-500': run.status === 'failed',
                  'bg-indigo-500 animate-pulse': run.status === 'running',
                  'bg-gray-300 dark:bg-gray-600': !['success', 'failed', 'running'].includes(run.status),
                }"
              />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span
                    class="text-[12px] font-medium truncate"
                    :class="selectedRunId === run.id
                      ? 'text-indigo-600 dark:text-indigo-400'
                      : 'text-gray-700 dark:text-gray-300'"
                  >{{ flatPhases.find(p => p.id === run.phase_id)?.name ?? run.phase_id }}</span>
                  <span
                    class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium"
                    :class="{
                      'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400': run.status === 'success',
                      'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400': run.status === 'failed',
                      'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400': run.status === 'running',
                      'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-500': !['success', 'failed', 'running'].includes(run.status),
                    }"
                  >{{ run.status }}</span>
                </div>
                <div class="text-[10px] text-gray-400 dark:text-gray-600 mt-0.5">
                  {{ formatTime(run.started_at) }}
                  <span v-if="run.session_id" class="ml-1 font-mono">{{ run.session_id.slice(0, 8) }}</span>
                  <span v-else class="ml-1 italic">无 session</span>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                  <span v-if="run.model" class="text-[10px] font-mono text-violet-500 dark:text-violet-400">{{ run.model }}</span>
                  <span v-if="run.token_usage" class="text-[10px] text-gray-400 dark:text-gray-600 tabular-nums">
                    {{ run.token_usage.toLocaleString() }} tokens
                  </span>
                </div>
              </div>
            </button>
          </div>
        </div>

        <!-- Transcript view (Turn-based) -->
        <div class="flex-1 overflow-y-auto">
          <div v-if="loadingTranscript" class="flex items-center justify-center h-full text-[13px] text-gray-400">
            <div class="i-carbon-circle-dash w-5 h-5 animate-spin mr-2" />
            加载会话数据...
          </div>
          <div v-else-if="selectedRunId && transcriptTurns.length > 0" class="transcript-view">
            <!-- Header -->
            <div class="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-[#1a1a1e] border-b border-gray-200 dark:border-white/5">
              <div class="i-carbon-data-base w-3.5 h-3.5 text-gray-400" />
              <span class="text-[12px] text-gray-500 dark:text-gray-400">
                {{ transcriptTurns.length }} 轮对话
              </span>
              <span v-if="transcriptFormat" class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400">
                {{ transcriptFormat }}
              </span>
              <span
                v-if="agentRuns.find(r => r.id === selectedRunId)?.model"
                class="px-1.5 py-0.5 rounded text-[10px] font-medium font-mono bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400"
              >
                {{ agentRuns.find(r => r.id === selectedRunId)?.model }}
              </span>
              <span v-if="transcriptFilePath" class="text-[10px] font-mono text-gray-400 dark:text-gray-600 truncate ml-auto">
                {{ transcriptFilePath }}
              </span>
            </div>

            <!-- Turns -->
            <div class="p-4 space-y-4">
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
                    <!-- Text block -->
                    <div v-if="block.kind === 'text'" class="rounded-xl px-4 py-3 bg-white dark:bg-[#28282c] border border-gray-100 dark:border-white/[0.04] shadow-sm shadow-black/[0.02] dark:shadow-none">
                      <div class="prose-chat text-[13px] leading-relaxed text-gray-700 dark:text-gray-200" v-html="md.render(block.text)" />
                    </div>

                    <!-- Thinking block -->
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

                    <!-- Tool use block -->
                    <div
                      v-else-if="block.kind === 'tool_use' && block.tool_call"
                      class="rounded-lg overflow-hidden border"
                      :class="block.tool_call.is_error
                        ? 'border-red-200 dark:border-red-500/15'
                        : 'border-gray-200 dark:border-white/[0.06]'"
                    >
                      <!-- Tool header -->
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
                      <!-- Expanded: input + result -->
                      <div v-if="expandedBlocks.has(`tool-${turn.index}-${bIdx}`)" class="border-t border-gray-100 dark:border-white/[0.04]">
                        <!-- Input -->
                        <div class="px-3 py-2 bg-[#fafafa] dark:bg-[#161618]">
                          <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">Input</div>
                          <pre class="text-[11px] font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">{{ formatToolInput(block.tool_call.input) }}</pre>
                        </div>
                        <!-- Result -->
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
          </div>
          <div v-else-if="selectedRunId && !agentRuns.find(r => r.id === selectedRunId)?.session_id" class="flex items-center justify-center h-full text-gray-300 dark:text-gray-600 text-[13px]">
            <div class="text-center">
              <div class="i-carbon-warning-alt w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>该次运行无关联的 session ID</p>
            </div>
          </div>
          <div v-else class="flex items-center justify-center h-full text-gray-300 dark:text-gray-600 text-[13px]">
            <div class="text-center">
              <div class="i-carbon-data-base w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>选择左侧会话查看数据</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Files tab — changed files + diff -->
      <div v-show="activeTab === 'files' && !isPending" class="flex h-full">
        <!-- File list sidebar -->
        <div class="w-72 border-r border-gray-200 dark:border-white/5 overflow-y-auto bg-[#fafafa] dark:bg-[#1e1e22] flex flex-col">
          <!-- Summary header -->
          <div class="px-3 py-2.5 border-b border-gray-100 dark:border-white/[0.03] flex items-center justify-between">
            <span class="text-[12px] font-medium text-gray-500 dark:text-gray-400">
              变更文件
              <span v-if="changedFiles.length" class="ml-1 text-gray-400 dark:text-gray-500">({{ changedFiles.length }})</span>
            </span>
            <button
              class="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              title="刷新"
              @click="loadChangedFiles"
            >
              <div class="i-carbon-renew w-3.5 h-3.5 text-gray-400" :class="loadingFiles && 'animate-spin'" />
            </button>
          </div>

          <!-- File entries -->
          <div class="flex-1 overflow-y-auto py-1">
            <div v-if="loadingFiles" class="flex items-center justify-center h-20 text-[12px] text-gray-400">
              <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
              加载中...
            </div>
            <div
              v-else-if="changedFiles.length === 0"
              class="flex flex-col items-center justify-center h-32 text-[12px] text-gray-300 dark:text-gray-600"
            >
              <div class="i-carbon-document-add w-8 h-8 mb-2 opacity-30" />
              暂无变更文件
            </div>
            <button
              v-for="file in changedFiles"
              :key="file.path"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              :class="selectedFilePath === file.path && 'bg-indigo-50 dark:bg-indigo-500/10'"
              @click="selectChangedFile(file.path)"
            >
              <span
                class="shrink-0 w-4 text-center text-[10px] font-bold"
                :class="fileStatusColor(file.status)"
              >{{ fileStatusLabel(file.status) }}</span>
              <div class="flex-1 min-w-0">
                <div
                  class="text-[12px] truncate"
                  :class="selectedFilePath === file.path
                    ? 'text-indigo-600 dark:text-indigo-400 font-medium'
                    : 'text-gray-700 dark:text-gray-300'"
                >{{ fileName(file.path) }}</div>
                <div v-if="fileDir(file.path)" class="text-[10px] text-gray-400 dark:text-gray-600 truncate">
                  {{ fileDir(file.path) }}
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-1 text-[10px] tabular-nums">
                <span v-if="file.additions" class="text-emerald-500">+{{ file.additions }}</span>
                <span v-if="file.deletions" class="text-red-400">-{{ file.deletions }}</span>
              </div>
            </button>
          </div>

          <!-- Stats footer -->
          <div
            v-if="changedFiles.length"
            class="px-3 py-2 border-t border-gray-100 dark:border-white/[0.03] text-[11px] text-gray-400 dark:text-gray-500 tabular-nums flex gap-3"
          >
            <span class="text-emerald-500">+{{ changedFiles.reduce((s, f) => s + f.additions, 0) }}</span>
            <span class="text-red-400">-{{ changedFiles.reduce((s, f) => s + f.deletions, 0) }}</span>
          </div>
        </div>

        <!-- Diff view -->
        <div class="flex-1 overflow-y-auto">
          <div v-if="loadingDiff" class="flex items-center justify-center h-full text-[13px] text-gray-400">
            <div class="i-carbon-circle-dash w-5 h-5 animate-spin mr-2" />
            加载 diff...
          </div>
          <div v-else-if="fileDiff && selectedFilePath" class="diff-view">
            <!-- Diff file header -->
            <div class="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-[#1a1a1e] border-b border-gray-200 dark:border-white/5">
              <span
                class="text-[10px] font-bold px-1 rounded"
                :class="fileStatusColor(changedFiles.find(f => f.path === selectedFilePath)?.status ?? 'modified')"
              >{{ fileStatusLabel(changedFiles.find(f => f.path === selectedFilePath)?.status ?? 'modified') }}</span>
              <span class="text-[13px] font-mono text-gray-600 dark:text-gray-300">{{ selectedFilePath }}</span>
            </div>
            <!-- Diff lines -->
            <table class="diff-table w-full text-[12px] font-mono leading-[1.6]">
              <tbody>
                <template v-for="(line, idx) in parseDiffLines(fileDiff)" :key="idx">
                  <tr v-if="line.type === 'hunk'" class="diff-hunk">
                    <td colspan="3" class="px-4 py-1 text-[11px] text-blue-500 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-500/5 select-none">
                      {{ line.content }}
                    </td>
                  </tr>
                  <tr
                    v-else
                    class="diff-line"
                    :class="{
                      'bg-emerald-50 dark:bg-emerald-500/[0.06]': line.type === 'add',
                      'bg-red-50 dark:bg-red-500/[0.06]': line.type === 'del',
                    }"
                  >
                    <td class="diff-ln w-10 text-right pr-2 select-none text-gray-300 dark:text-gray-600">{{ line.oldNum ?? '' }}</td>
                    <td class="diff-ln w-10 text-right pr-2 select-none text-gray-300 dark:text-gray-600">{{ line.newNum ?? '' }}</td>
                    <td class="px-3 whitespace-pre-wrap break-all">
                      <span
                        class="select-none mr-1"
                        :class="{
                          'text-emerald-500': line.type === 'add',
                          'text-red-400': line.type === 'del',
                          'text-gray-300 dark:text-gray-600': line.type === 'ctx',
                        }"
                      >{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
                      <span
                        :class="{
                          'text-emerald-700 dark:text-emerald-300': line.type === 'add',
                          'text-red-600 dark:text-red-300': line.type === 'del',
                          'text-gray-600 dark:text-gray-400': line.type === 'ctx',
                        }"
                      >{{ line.content }}</span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <div v-else class="flex items-center justify-center h-full text-gray-300 dark:text-gray-600 text-[13px]">
            <div class="text-center">
              <div class="i-carbon-compare w-10 h-10 mx-auto mb-2 opacity-30" />
              <p>选择左侧文件查看变更</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Reset / Rollback confirm dialog -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showResetConfirm"
          class="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="showResetConfirm = false" />
          <div class="relative bg-white dark:bg-[#28282c] rounded-2xl shadow-xl shadow-black/10 dark:shadow-black/40 w-[360px] p-5 mx-4">
            <div class="flex items-center gap-2.5 mb-3">
              <div
                class="w-8 h-8 rounded-full flex items-center justify-center"
                :class="isViewingPastPhase ? 'bg-amber-50 dark:bg-amber-500/10' : 'bg-red-50 dark:bg-red-500/10'"
              >
                <div
                  class="w-4 h-4"
                  :class="isViewingPastPhase ? 'i-carbon-warning-alt text-amber-500' : 'i-carbon-reset text-red-500'"
                />
              </div>
              <h3 class="text-[14px] font-semibold text-gray-800 dark:text-gray-100">
                {{ isViewingPastPhase ? '确认回滚' : '确认重置当前阶段' }}
              </h3>
            </div>
            <p class="text-[13px] text-gray-500 dark:text-gray-400 leading-relaxed mb-4 pl-[42px]">
              <template v-if="isViewingPastPhase">
                将回滚到「<span class="font-medium text-gray-700 dark:text-gray-200">{{ flatPhases.find(p => p.id === viewingPhaseId)?.name }}</span>」阶段，该阶段及之后的所有产出（对话、代码变更）将被清除且不可恢复。
              </template>
              <template v-else>
                将重置当前阶段，该阶段的对话记录和代码变更将被清除并重新执行。
              </template>
            </p>
            <div v-if="isViewingPastPhase" class="flex flex-col gap-1.5 mb-4 pl-[42px]">
              <label
                class="flex items-center gap-2 cursor-pointer group"
                @click="rollbackPauseMode = false"
              >
                <span
                  class="w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center transition-colors"
                  :class="!rollbackPauseMode ? 'border-amber-500' : 'border-gray-300 dark:border-gray-600 group-hover:border-gray-400'"
                >
                  <span v-if="!rollbackPauseMode" class="w-1.5 h-1.5 rounded-full bg-amber-500" />
                </span>
                <span class="text-[12px] text-gray-600 dark:text-gray-300">回滚并立即开始</span>
              </label>
              <label
                class="flex items-center gap-2 cursor-pointer group"
                @click="rollbackPauseMode = true"
              >
                <span
                  class="w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center transition-colors"
                  :class="rollbackPauseMode ? 'border-amber-500' : 'border-gray-300 dark:border-gray-600 group-hover:border-gray-400'"
                >
                  <span v-if="rollbackPauseMode" class="w-1.5 h-1.5 rounded-full bg-amber-500" />
                </span>
                <span class="text-[12px] text-gray-600 dark:text-gray-300">回滚并等待输入</span>
              </label>
            </div>
            <div class="flex justify-end gap-2">
              <button
                class="px-4 py-2 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="showResetConfirm = false"
              >
                取消
              </button>
              <button
                class="px-4 py-2 rounded-lg text-white text-[13px] font-medium shadow-sm transition-all duration-150 active:scale-[0.97]"
                :class="isViewingPastPhase
                  ? 'bg-amber-500 hover:bg-amber-400 shadow-amber-500/20'
                  : 'bg-red-500 hover:bg-red-400 shadow-red-500/20'"
                @click="confirmReset"
              >
                {{ isViewingPastPhase ? '确认回滚' : '确认重置' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Prompt preview dialog -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showPromptPreview"
          class="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="showPromptPreview = false" />
          <div class="relative bg-white dark:bg-[#28282c] rounded-2xl shadow-xl shadow-black/10 dark:shadow-black/40 w-[720px] max-w-[90vw] max-h-[80vh] flex flex-col mx-4">
            <!-- Header -->
            <div class="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100 dark:border-white/[0.04] shrink-0">
              <div class="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center">
                <div class="i-carbon-code w-4 h-4 text-indigo-500" />
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-[14px] font-semibold text-gray-800 dark:text-gray-100">
                  Agent 提示词预览
                </h3>
                <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                  {{ flatPhases.find(p => p.id === (viewingPhaseId ?? task?.current_phase))?.stageName }}
                  · {{ flatPhases.find(p => p.id === (viewingPhaseId ?? task?.current_phase))?.name }}
                </p>
              </div>
              <button
                class="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="showPromptPreview = false"
              >
                <div class="i-carbon-close w-4 h-4 text-gray-400" />
              </button>
            </div>
            <!-- Body -->
            <div class="flex-1 overflow-y-auto p-5 min-h-0">
              <div v-if="loadingPrompt" class="flex items-center justify-center py-12 text-[13px] text-gray-400">
                <div class="i-carbon-circle-dash w-5 h-5 animate-spin mr-2" />
                正在生成预览...
              </div>
              <div v-else class="prose-chat text-[13px] leading-relaxed text-gray-700 dark:text-gray-200" v-html="md.render(promptPreviewContent)" />
            </div>
            <!-- Footer -->
            <div class="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-white/[0.04] shrink-0">
              <span class="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                {{ promptPreviewContent.length.toLocaleString() }} 字符
              </span>
              <button
                class="px-3 py-1.5 rounded-lg text-[12px] font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="showPromptPreview = false"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style>
.prose-chat {
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: break-word;
  word-break: break-word;
  min-width: 0;
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
.prose-chat blockquote {
  border-left: 3px solid #d1d5db;
  padding-left: 0.8em;
  margin: 0.5em 0;
  color: #6b7280;
}
:is(.dark) .prose-chat blockquote {
  border-left-color: #4b5563;
  color: #9ca3af;
}
.prose-chat a {
  color: #6366f1;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.prose-chat table {
  max-width: 100%;
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.95em;
  display: block;
  overflow-x: auto;
}
.prose-chat th, .prose-chat td {
  border: 1px solid #e5e7eb;
  padding: 0.35em 0.6em;
  text-align: left;
}
:is(.dark) .prose-chat th, :is(.dark) .prose-chat td {
  border-color: rgba(255,255,255,0.1);
}
.prose-chat th {
  font-weight: 600;
  background: rgba(0,0,0,0.03);
}
:is(.dark) .prose-chat th {
  background: rgba(255,255,255,0.04);
}
.prose-chat hr {
  border: none;
  border-top: 1px solid #e5e7eb;
  margin: 0.8em 0;
}
:is(.dark) .prose-chat hr {
  border-top-color: rgba(255,255,255,0.08);
}
.prose-chat img {
  max-width: 100%;
  border-radius: 8px;
}
.diff-table {
  border-collapse: collapse;
}
.diff-table td {
  vertical-align: top;
}
.diff-ln {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  min-width: 2.5em;
  border-right: 1px solid rgba(0,0,0,0.06);
}
:is(.dark) .diff-ln {
  border-right-color: rgba(255,255,255,0.04);
}
.diff-hunk td {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace;
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.15s ease;
}
.modal-enter-active > div:last-child,
.modal-leave-active > div:last-child {
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from > div:last-child {
  transform: scale(0.95);
  opacity: 0;
}
.modal-leave-to > div:last-child {
  transform: scale(0.95);
  opacity: 0;
}
</style>
