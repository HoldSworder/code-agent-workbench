<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { rpc } from '../composables/use-sidecar'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const route = useRoute()
const router = useRouter()
const taskId = route.params.taskId as string
const repoId = route.params.repoId as string

const activeTab = ref<'chat' | 'files'>('chat')

interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
  created_at: string
  updated_at: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

const task = ref<RepoTask | null>(null)
const messages = ref<ChatMessage[]>([])
const chatInput = ref('')
const liveOutput = ref('')
const chatContainer = ref<HTMLElement>()

interface WorkflowPhase {
  id: string
  name: string
}

const workflowPhases = ref<WorkflowPhase[]>([])
const rollingBack = ref(false)

const phaseLabel: Record<string, string> = {
  design: '设计探索',
  plan: '任务规划',
  't1-dev': 'T1 开发',
  review: '代码审查',
  verify: '验证',
  mr: '创建 MR',
  'backend-spec-arrived': '后端联调',
  'test-spec-arrived': '测试 Spec',
  'e2e-verify': 'E2E 验证',
  archive: '归档',
}

const statusLabel: Record<string, string> = {
  running: '运行中',
  waiting_confirm: '待确认',
  waiting_event: '等待事件',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const displayPhase = computed(() =>
  task.value ? (phaseLabel[task.value.current_phase] ?? task.value.current_phase) : '',
)

const displayStatus = computed(() =>
  task.value ? (statusLabel[task.value.phase_status] ?? task.value.phase_status) : '',
)

const isRunning = computed(() => task.value?.phase_status === 'running')

const currentPhaseIndex = computed(() => {
  if (!task.value) return -1
  return workflowPhases.value.findIndex(p => p.id === task.value!.current_phase)
})

function phaseState(index: number): 'done' | 'active' | 'future' {
  const ci = currentPhaseIndex.value
  if (ci === -1) return 'future'
  if (index < ci) return 'done'
  if (index === ci) return 'active'
  return 'future'
}

const rollbackTarget = ref<{ id: string, name: string } | null>(null)

function requestRollback(targetPhaseId: string) {
  if (!task.value || isRunning.value || rollingBack.value) return
  const phase = workflowPhases.value.find(p => p.id === targetPhaseId)
  if (phase) rollbackTarget.value = { id: phase.id, name: phase.name }
}

function cancelRollback() {
  rollbackTarget.value = null
}

async function confirmRollback() {
  if (!task.value || !rollbackTarget.value) return
  const targetPhaseId = rollbackTarget.value.id
  rollbackTarget.value = null
  rollingBack.value = true
  try {
    await rpc('workflow.rollback', { repoTaskId: task.value.id, targetPhaseId })
    messages.value = []
    liveOutput.value = ''
    await new Promise(r => setTimeout(r, 300))
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) task.value = t
    startPolling()
  }
  finally {
    rollingBack.value = false
  }
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
    const res = await rpc<{ output: string }>('task.getLiveOutput', { repoTaskId: taskId })
    if (res?.output && res.output !== liveOutput.value) {
      liveOutput.value = res.output
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null }
      scrollToBottom()
    }
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) {
      task.value = t
      if (t.phase_status !== 'running') {
        clearInterval(pollTimer!)
        pollTimer = null
        await refreshMessages()
        liveOutput.value = ''
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
}

watch(isRunning, (running) => {
  if (running) startPolling()
  else stopPolling()
})

watch(activeTab, (tab) => {
  if (tab === 'files') loadChangedFiles()
})

async function refreshMessages() {
  if (!task.value) return
  const msgs = await rpc<ChatMessage[]>('message.list', {
    taskId: task.value.id,
    phaseId: task.value.current_phase,
  })
  if (msgs) {
    messages.value = msgs
    scrollToBottom()
  }
}

onMounted(async () => {
  const [t, phasesRes] = await Promise.all([
    rpc<RepoTask>('task.get', { id: taskId }),
    rpc<{ phases: WorkflowPhase[] }>('workflow.phases'),
  ])
  if (t) task.value = t
  if (phasesRes?.phases) workflowPhases.value = phasesRes.phases
  await refreshMessages()
  if (isRunning.value) startPolling()
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

async function handleConfirm() {
  if (!task.value) return
  await rpc('workflow.confirm', { repoTaskId: task.value.id })
  await new Promise(r => setTimeout(r, 300))
  const t = await rpc<RepoTask>('task.get', { id: taskId })
  if (t) task.value = t
  startPolling()
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
  e.preventDefault()
  sendMessage()
}

async function handleFeedback() {
  activeTab.value = 'chat'
}

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

function requestReset() {
  if (!task.value || resetting.value) return
  showResetConfirm.value = true
}

async function confirmReset() {
  showResetConfirm.value = false
  if (!task.value || resetting.value) return
  resetting.value = true
  try {
    await rpc('workflow.resetPhase', { repoTaskId: task.value.id })
    messages.value = []
    liveOutput.value = ''

    await new Promise(r => setTimeout(r, 300))
    const t = await rpc<RepoTask>('task.get', { id: taskId })
    if (t) task.value = t
    startPolling()
  }
  finally {
    resetting.value = false
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
            'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400': task.phase_status === 'waiting_event',
            'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400': task.phase_status === 'failed',
            'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400': task.phase_status === 'running',
            'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400': task.phase_status === 'completed',
            'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-500': task.phase_status === 'cancelled',
          }"
        >
          {{ displayPhase }} · {{ displayStatus }}
        </span>
      </div>
      <div v-else class="flex-1 text-[13px] text-gray-400">加载中...</div>

      <!-- Reset button -->
      <button
        v-if="task && !isRunning"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
        :disabled="resetting"
        @click="requestReset"
      >
        <div class="w-3.5 h-3.5" :class="resetting ? 'i-carbon-circle-dash animate-spin' : 'i-carbon-reset'" />
        {{ resetting ? '重置中...' : '重置' }}
      </button>

      <!-- Tab toggle -->
      <div class="flex bg-gray-100 dark:bg-white/5 rounded-lg p-0.5">
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
      </div>
    </div>

    <!-- Phase stepper -->
    <div
      v-if="workflowPhases.length > 0 && task"
      class="flex items-center gap-0 px-5 py-2 border-b border-gray-100 dark:border-white/[0.03] bg-gray-50/50 dark:bg-[#1a1a1e]/50 overflow-x-auto"
    >
      <template v-for="(phase, idx) in workflowPhases" :key="phase.id">
        <button
          class="group flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all duration-150"
          :class="{
            'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 cursor-pointer': phaseState(idx) === 'done' && !isRunning,
            'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10': phaseState(idx) === 'active',
            'text-gray-300 dark:text-gray-600 cursor-default': phaseState(idx) === 'future',
            'pointer-events-none': isRunning || rollingBack,
          }"
          :disabled="phaseState(idx) === 'future' || phaseState(idx) === 'active' || isRunning"
          :title="phaseState(idx) === 'done' ? `回滚到「${phase.name}」` : ''"
          @click="phaseState(idx) === 'done' && requestRollback(phase.id)"
        >
          <div
            class="w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold border transition-colors"
            :class="{
              'bg-emerald-500 border-emerald-500 text-white': phaseState(idx) === 'done',
              'bg-indigo-500 border-indigo-500 text-white': phaseState(idx) === 'active',
              'bg-transparent border-gray-200 dark:border-white/10 text-gray-300 dark:text-gray-600': phaseState(idx) === 'future',
            }"
          >
            <div v-if="phaseState(idx) === 'done'" class="i-carbon-checkmark w-2.5 h-2.5" />
            <div v-else-if="phaseState(idx) === 'active' && isRunning" class="i-carbon-circle-dash w-2.5 h-2.5 animate-spin" />
            <span v-else>{{ idx + 1 }}</span>
          </div>
          {{ phase.name }}
        </button>
        <div
          v-if="idx < workflowPhases.length - 1"
          class="w-4 h-px mx-0.5 shrink-0"
          :class="phaseState(idx) === 'done' ? 'bg-emerald-300 dark:bg-emerald-500/30' : 'bg-gray-200 dark:bg-white/5'"
        />
      </template>
      <div v-if="rollingBack" class="ml-2 text-[11px] text-amber-500 animate-pulse">回滚中...</div>
    </div>

    <!-- Content area -->
    <div class="flex-1 overflow-hidden">
      <!-- Chat tab — full width -->
      <div v-show="activeTab === 'chat'" class="flex flex-col h-full">
        <div ref="chatContainer" class="flex-1 overflow-y-auto px-6 py-4">
          <div class="max-w-2xl mx-auto space-y-3">
            <div
              v-for="msg in messages"
              :key="msg.id"
              class="flex"
              :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[85%] rounded-2xl px-4 py-3 text-[13px] leading-relaxed"
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
            </div>

            <!-- Live streaming output -->
            <div v-if="liveOutput" class="flex justify-start">
              <div class="max-w-[85%] rounded-2xl rounded-bl-md px-4 py-3 bg-white dark:bg-[#28282c] shadow-sm shadow-black/[0.04] dark:shadow-none">
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

            <!-- Running indicator (no output yet) -->
            <div v-else-if="isRunning && !liveOutput" class="flex justify-start">
              <div class="flex items-center gap-2 px-4 py-3 rounded-2xl rounded-bl-md bg-white dark:bg-[#28282c] shadow-sm shadow-black/[0.04] dark:shadow-none">
                <div class="flex gap-1">
                  <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style="animation-delay: 0ms" />
                  <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style="animation-delay: 150ms" />
                  <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style="animation-delay: 300ms" />
                </div>
                <span class="text-[12px] text-gray-400">Agent 正在启动...{{ waitSeconds > 5 ? ` (${waitSeconds}s)` : '' }}</span>
              </div>
            </div>

            <!-- Empty state -->
            <div
              v-if="messages.length === 0 && !liveOutput && !isRunning"
              class="flex items-center justify-center py-20 text-gray-300 dark:text-gray-600 text-[13px]"
            >
              <div class="text-center">
                <div class="i-carbon-chat w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>暂无对话记录</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Input bar -->
        <div class="border-t border-gray-200 dark:border-white/5 p-4 bg-white/60 dark:bg-[#1e1e22]/60 backdrop-blur-sm">
          <div class="max-w-2xl mx-auto flex gap-2">
            <input
              v-model="chatInput"
              type="text"
              placeholder="输入反馈或指令..."
              class="flex-1 px-4 py-2.5 rounded-xl bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
              @keydown.enter="onKeydownEnter"
            >
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

      <!-- Files tab — changed files + diff -->
      <div v-show="activeTab === 'files'" class="flex h-full">
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

    <!-- Confirm bar -->
    <div
      v-if="task?.phase_status === 'waiting_confirm'"
      class="flex items-center gap-3 px-6 py-3 border-t border-amber-200/50 dark:border-amber-500/10 bg-amber-50/50 dark:bg-amber-500/5"
    >
      <div class="i-carbon-warning-alt w-4 h-4 text-amber-500" />
      <span class="text-[13px] text-amber-700 dark:text-amber-400 font-medium flex-1">
        {{ displayPhase }} 阶段已完成，请确认是否继续推进
      </span>
      <button
        class="px-3 py-1.5 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        @click="handleCancel"
      >
        取消任务
      </button>
      <button
        class="px-3 py-1.5 rounded-lg text-[13px] text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-500/20 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors"
        @click="handleFeedback"
      >
        反馈修改
      </button>
      <button
        class="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-[13px] font-medium hover:bg-amber-400 shadow-sm shadow-amber-500/20 transition-all duration-150 active:scale-[0.97]"
        @click="handleConfirm"
      >
        确认通过
      </button>
    </div>

    <!-- Rollback confirm dialog -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="rollbackTarget"
          class="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="cancelRollback" />
          <div class="relative bg-white dark:bg-[#28282c] rounded-2xl shadow-xl shadow-black/10 dark:shadow-black/40 w-[360px] p-5 mx-4">
            <div class="flex items-center gap-2.5 mb-3">
              <div class="w-8 h-8 rounded-full bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center">
                <div class="i-carbon-warning-alt w-4 h-4 text-amber-500" />
              </div>
              <h3 class="text-[14px] font-semibold text-gray-800 dark:text-gray-100">确认回滚</h3>
            </div>
            <p class="text-[13px] text-gray-500 dark:text-gray-400 leading-relaxed mb-5 pl-[42px]">
              将回滚到「<span class="font-medium text-gray-700 dark:text-gray-200">{{ rollbackTarget.name }}</span>」阶段，该阶段及之后的所有产出（对话、代码变更）将被清除且不可恢复。
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="px-4 py-2 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="cancelRollback"
              >
                取消
              </button>
              <button
                class="px-4 py-2 rounded-lg bg-amber-500 text-white text-[13px] font-medium hover:bg-amber-400 shadow-sm shadow-amber-500/20 transition-all duration-150 active:scale-[0.97]"
                @click="confirmRollback"
              >
                确认回滚
              </button>
            </div>
          </div>
        </div>
      </Transition>

      <Transition name="modal">
        <div
          v-if="showResetConfirm"
          class="fixed inset-0 z-50 flex items-center justify-center"
        >
          <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="showResetConfirm = false" />
          <div class="relative bg-white dark:bg-[#28282c] rounded-2xl shadow-xl shadow-black/10 dark:shadow-black/40 w-[360px] p-5 mx-4">
            <div class="flex items-center gap-2.5 mb-3">
              <div class="w-8 h-8 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center">
                <div class="i-carbon-reset w-4 h-4 text-red-500" />
              </div>
              <h3 class="text-[14px] font-semibold text-gray-800 dark:text-gray-100">确认重置当前阶段</h3>
            </div>
            <p class="text-[13px] text-gray-500 dark:text-gray-400 leading-relaxed mb-5 pl-[42px]">
              将重置当前阶段，该阶段的对话记录和代码变更将被清除并重新执行。如需重置整个任务，请点击第一阶段标签进行回滚。
            </p>
            <div class="flex justify-end gap-2">
              <button
                class="px-4 py-2 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                @click="showResetConfirm = false"
              >
                取消
              </button>
              <button
                class="px-4 py-2 rounded-lg bg-red-500 text-white text-[13px] font-medium hover:bg-red-400 shadow-sm shadow-red-500/20 transition-all duration-150 active:scale-[0.97]"
                @click="confirmReset"
              >
                确认重置
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
  width: 100%;
  border-collapse: collapse;
  margin: 0.5em 0;
  font-size: 0.95em;
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
