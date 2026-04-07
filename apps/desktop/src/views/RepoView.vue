<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTasksStore } from '../stores/tasks'
import { useRequirementsStore } from '../stores/requirements'
import { useReposStore } from '../stores/repos'
import { rpc } from '../composables/use-sidecar'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const route = useRoute()
const router = useRouter()

const repoId = route.params.id as string
const tasksStore = useTasksStore()
const requirementsStore = useRequirementsStore()
const reposStore = useReposStore()

const phaseLabel: Record<string, string> = {
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

const statusConfig: Record<string, { label: string, dotClass: string, badgeClass: string }> = {
  running: {
    label: '运行中',
    dotClass: 'bg-indigo-500 animate-pulse',
    badgeClass: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400',
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

const repoName = computed(() =>
  reposStore.repos.find(r => r.id === repoId)?.name ?? repoId,
)

const requirementById = computed(() =>
  Object.fromEntries(requirementsStore.requirements.map(r => [r.id, r])),
)

const ACTIVE_STATUSES = new Set(['running', 'waiting_confirm', 'waiting_event', 'failed'])

const activeTasks = computed(() =>
  tasksStore.tasks
    .filter(t => ACTIVE_STATUSES.has(t.phase_status))
    .sort((a, b) => normalizeTime(b.updated_at) - normalizeTime(a.updated_at)),
)

const historyTasks = computed(() =>
  tasksStore.tasks
    .filter(t => !ACTIVE_STATUSES.has(t.phase_status))
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
  router.push(`/repo/${repoId}/task/${taskId}`)
}

// ── Sessions ──

interface SessionSummary {
  sessionId: string
  filePath: string
  provider: string
  modifiedAt: string
  sizeBytes: number
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
const loadingSessions = ref(false)
const showSessionDetail = ref(false)
const selectedSession = ref<SessionSummary | null>(null)
const transcriptTurns = ref<TranscriptTurn[]>([])
const transcriptFormat = ref('')
const transcriptFilePath = ref<string | null>(null)
const loadingTranscript = ref(false)
const expandedBlocks = ref<Set<string>>(new Set())

async function loadSessions() {
  loadingSessions.value = true
  try {
    const res = await rpc<SessionSummary[]>('repo.sessions', { repoId })
    sessions.value = res ?? []
  }
  catch { sessions.value = [] }
  finally { loadingSessions.value = false }
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

// ── Lifecycle ──

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await Promise.all([
    requirementsStore.fetchAll(),
    reposStore.fetchAll(),
    tasksStore.fetchByRepo(repoId),
    loadSessions(),
  ])
  pollTimer = setInterval(() => tasksStore.fetchByRepo(repoId), 5000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

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
  <div class="h-full flex flex-col">
    <!-- Header -->
    <div class="flex items-center gap-3 px-6 py-4 border-b border-gray-200 dark:border-white/5 bg-white/80 dark:bg-[#1e1e22]/80 backdrop-blur-sm">
      <button
        class="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
        @click="router.push('/')"
      >
        <div class="i-carbon-arrow-left w-4 h-4 text-gray-400" />
      </button>
      <div>
        <h1 class="text-[15px] font-semibold tracking-tight">{{ repoName }}</h1>
        <p class="text-[12px] text-gray-400 mt-0.5">
          {{ activeTasks.length }} 个运行中 · {{ historyTasks.length }} 个已结束
        </p>
      </div>
    </div>

    <div class="flex-1 overflow-hidden flex gap-0">
      <!-- Left column: Pipeline (进行中 + 历史任务) -->
      <div class="flex-1 min-w-0 overflow-y-auto px-5 py-5 border-r border-gray-100 dark:border-white/[0.04]">
        <div class="flex items-center gap-2 mb-4">
          <div class="i-carbon-flow w-3.5 h-3.5 text-gray-400 opacity-60" />
          <h2 class="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">流水线</h2>
        </div>

        <div class="space-y-6">
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
                @click="openTask(task.id)"
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
                        {{ phaseLabel[task.current_phase] ?? task.current_phase }} · {{ statusConfig[task.phase_status]?.label ?? task.phase_status }}
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
      <div class="flex-1 min-w-0 overflow-y-auto px-5 py-5">
        <div class="flex items-center gap-2 mb-4">
          <div class="i-carbon-data-base w-3.5 h-3.5 text-gray-400 opacity-60" />
          <h2 class="text-[13px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Agent 会话</h2>
          <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
            {{ sessions.length }}
          </span>
          <button
            class="ml-auto p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
            title="刷新"
            @click="loadSessions"
          >
            <div class="i-carbon-renew w-3.5 h-3.5 text-gray-400" :class="loadingSessions && 'animate-spin'" />
          </button>
        </div>

        <div v-if="loadingSessions && sessions.length === 0" class="flex items-center justify-center py-8 text-[12px] text-gray-400">
          <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
          扫描会话文件...
        </div>

        <div v-else-if="sessions.length > 0" class="space-y-1.5">
          <div
            v-for="session in sessions"
            :key="session.sessionId"
            class="group flex items-center gap-3 px-3.5 py-2.5 bg-white dark:bg-[#28282c] rounded-lg border border-gray-100 dark:border-white/[0.04] transition-all cursor-pointer hover:shadow-sm hover:border-gray-200 dark:hover:border-white/[0.08]"
            @click="openSession(session)"
          >
            <div class="i-carbon-chat w-3.5 h-3.5 text-gray-400 shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-[12px] font-mono text-gray-700 dark:text-gray-200 truncate">
                {{ session.sessionId }}
              </p>
              <div class="flex items-center gap-2 mt-0.5">
                <span class="px-1.5 py-0.5 rounded text-[9px] font-medium bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400">
                  {{ session.provider }}
                </span>
                <span class="text-[10px] text-gray-400 tabular-nums">
                  {{ formatFileSize(session.sizeBytes) }}
                </span>
                <span class="text-[10px] text-gray-400 tabular-nums">
                  {{ formatDate(session.modifiedAt) }}
                </span>
              </div>
            </div>
            <div class="i-carbon-chevron-right w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
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
