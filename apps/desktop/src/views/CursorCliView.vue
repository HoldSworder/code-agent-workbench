<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import MarkdownIt from 'markdown-it'
import { rpc } from '../composables/use-sidecar'
import CursorTerminal from '../components/CursorTerminal.vue'

defineOptions({ name: 'CursorCliView' })

const SESSION_PAGE = 30
const SIDEBAR_KEY = 'cursorCli.sidebarOpen'
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// ── Types ──
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

interface TerminalTab {
  id: string
  label: string
  sessionId?: string
  editing?: boolean
}

// ── State ──
const projectRoot = ref('')
const sessions = ref<SessionSummary[]>([])
const sessionsTotal = ref(0)
const loadingSessions = ref(false)
const loadingMoreSessions = ref(false)
const sessionQuery = ref('')

const sidebarOpen = ref(localStorage.getItem(SIDEBAR_KEY) !== 'false')

const terminalTabs = ref<TerminalTab[]>([])
const activeTerminalId = ref<string | null>(null)
const terminalRefs = ref<Record<string, InstanceType<typeof CursorTerminal>>>({})
let terminalIdCounter = 0

// Session detail drawer
const showSessionDetail = ref(false)
const selectedSession = ref<SessionSummary | null>(null)
const transcriptTurns = ref<TranscriptTurn[]>([])
const transcriptFormat = ref('')
const transcriptFilePath = ref<string | null>(null)
const loadingTranscript = ref(false)
const expandedBlocks = ref<Set<string>>(new Set())

// ── Utils ──
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

function copyProjectRoot() {
  if (!projectRoot.value) return
  navigator.clipboard?.writeText(projectRoot.value).catch(() => {})
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value
  localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen.value))
}

// ── Sessions ──
const filteredSessions = computed(() => {
  const q = sessionQuery.value.trim().toLowerCase()
  if (!q) return sessions.value
  return sessions.value.filter(s =>
    s.sessionId.toLowerCase().includes(q)
    || (s.firstTurnPreview ?? '').toLowerCase().includes(q),
  )
})

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
    const res = await rpc<{ items: SessionSummary[], total: number }>('system.sessions', {
      limit: SESSION_PAGE,
      offset,
    })
    const items = res?.items ?? []
    sessionsTotal.value = res?.total ?? 0
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

function onSessionsScroll(e: Event) {
  const el = e.target as HTMLElement
  if (loadingMoreSessions.value || loadingSessions.value) return
  if (sessions.value.length >= sessionsTotal.value) return
  if (sessionQuery.value.trim()) return // 搜索时不自动分页
  const threshold = 120
  if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
    void loadSessions(false)
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

// ── Terminal tabs ──
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
}

function closeTerminalTab(id: string) {
  const ref = terminalRefs.value[id]
  if (ref) {
    ref.dispose()
    delete terminalRefs.value[id]
  }
  const idx = terminalTabs.value.findIndex(t => t.id === id)
  terminalTabs.value = terminalTabs.value.filter(t => t.id !== id)
  if (activeTerminalId.value === id) {
    const next = terminalTabs.value[idx] ?? terminalTabs.value[idx - 1] ?? null
    activeTerminalId.value = next?.id ?? null
  }
}

function switchTerminalTab(id: string) {
  activeTerminalId.value = id
}

function resumeSession(session: SessionSummary) {
  terminalIdCounter++
  const shortId = session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId
  const tab: TerminalTab = {
    id: `term-${terminalIdCounter}`,
    label: `Resume ${shortId}`,
    sessionId: session.sessionId,
  }
  terminalTabs.value = [...terminalTabs.value, tab]
  activeTerminalId.value = tab.id
  if (!sidebarOpen.value) { /* 保留侧栏状态 */ }
}

function resumeFromDrawer() {
  if (!selectedSession.value) return
  resumeSession(selectedSession.value)
  closeSessionDetail()
}

function startRenameTab(tab: TerminalTab) {
  terminalTabs.value = terminalTabs.value.map(t => ({ ...t, editing: t.id === tab.id }))
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(`input[data-tab-input="${tab.id}"]`)
    input?.focus()
    input?.select()
  })
}

function commitRenameTab(tab: TerminalTab, e: Event) {
  const value = (e.target as HTMLInputElement).value.trim()
  terminalTabs.value = terminalTabs.value.map(t =>
    t.id === tab.id ? { ...t, label: value || t.label, editing: false } : t,
  )
}

// ── Keyboard shortcuts ──
function onKeydown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return
  // 编辑 input 时不拦截
  const target = e.target as HTMLElement
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
    return

  if (e.key === 't' || e.key === 'T') {
    e.preventDefault()
    addTerminalTab()
  }
  else if (e.key === 'w' || e.key === 'W') {
    if (activeTerminalId.value) {
      e.preventDefault()
      closeTerminalTab(activeTerminalId.value)
    }
  }
  else if (/^[1-9]$/.test(e.key)) {
    const idx = Number.parseInt(e.key, 10) - 1
    const tab = terminalTabs.value[idx]
    if (tab) {
      e.preventDefault()
      switchTerminalTab(tab.id)
    }
  }
}

// ── Lifecycle ──
onMounted(async () => {
  try {
    const res = await rpc<{ path: string }>('system.projectRoot')
    projectRoot.value = res?.path ?? ''
  }
  catch { projectRoot.value = '' }
  await loadSessions(true)
  if (terminalTabs.value.length === 0)
    addTerminalTab()
})

// keep-alive: 仅在页面活跃时监听快捷键，离开时解绑
onActivated(() => {
  window.addEventListener('keydown', onKeydown)
})
onDeactivated(() => {
  window.removeEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header -->
    <div class="flex items-center gap-3 px-6 py-3 border-b border-gray-200 dark:border-white/5 bg-white/80 dark:bg-[#1e1e22]/80 backdrop-blur-sm">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <h1 class="text-[15px] font-semibold tracking-tight">Cursor CLI</h1>
          <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
            {{ terminalTabs.length }} 终端
          </span>
          <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
            {{ sessionsTotal }} 会话
          </span>
        </div>
        <button
          v-if="projectRoot"
          class="mt-0.5 group inline-flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors max-w-full"
          :title="`点击复制：${projectRoot}`"
          @click="copyProjectRoot"
        >
          <div class="i-carbon-folder w-3.5 h-3.5 shrink-0 opacity-60" />
          <span class="font-mono truncate">{{ projectRoot }}</span>
          <div class="i-carbon-copy w-3 h-3 shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" />
        </button>
        <p v-else class="text-[12px] text-gray-400 mt-0.5">加载项目根目录...</p>
      </div>

      <button
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
          title="新建终端 (⌘T)"
        @click="addTerminalTab"
      >
        <div class="i-carbon-add w-3.5 h-3.5" />
        新建终端
      </button>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/5 transition-colors"
        :title="sidebarOpen ? '收起会话栏' : '展开会话栏'"
        @click="toggleSidebar"
      >
        <div :class="sidebarOpen ? 'i-carbon-side-panel-close' : 'i-carbon-side-panel-open'" class="w-4 h-4" />
      </button>
    </div>

    <div class="flex-1 min-h-0 flex">
      <!-- Left: terminals (main) -->
      <div class="flex-1 min-w-0 flex flex-col bg-[#1e1e22]">
        <!-- Tab bar -->
        <div class="flex items-center h-9 bg-[#1e1e22] border-b border-white/[0.06] px-1 gap-0.5 shrink-0 overflow-x-auto">
          <div
            v-for="(tab, i) in terminalTabs"
            :key="tab.id"
            class="group/tab flex items-center gap-1.5 px-2.5 h-7 rounded text-[11px] font-mono transition-all duration-100 shrink-0 max-w-[220px] cursor-pointer"
            :class="activeTerminalId === tab.id
              ? 'bg-white/10 text-gray-200'
              : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'"
            @click="switchTerminalTab(tab.id)"
            @dblclick="startRenameTab(tab)"
          >
            <div
              class="w-1.5 h-1.5 rounded-full shrink-0"
              :class="activeTerminalId === tab.id ? 'bg-emerald-500' : 'bg-gray-600'"
            />
            <span v-if="i < 9" class="text-[10px] text-gray-500 tabular-nums shrink-0">{{ i + 1 }}</span>
            <input
              v-if="tab.editing"
              :data-tab-input="tab.id"
              :value="tab.label"
              class="bg-transparent outline-none border-b border-indigo-400 text-gray-200 min-w-0 w-24 text-[11px] font-mono"
              @click.stop
              @blur="commitRenameTab(tab, $event)"
              @keydown.enter.prevent="commitRenameTab(tab, $event)"
              @keydown.esc="tab.editing = false"
            >
            <span v-else class="truncate" :title="tab.sessionId ?? ''">{{ tab.label }}</span>
            <div
              class="i-carbon-close w-3 h-3 shrink-0 opacity-0 group-hover/tab:opacity-70 hover:!opacity-100 transition-opacity"
              @click.stop="closeTerminalTab(tab.id)"
            />
          </div>

          <button
            class="flex items-center justify-center w-7 h-7 rounded text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors shrink-0 ml-0.5"
            title="新建终端 (⌘T)"
            @click="addTerminalTab"
          >
            <div class="i-carbon-add w-3.5 h-3.5" />
          </button>
        </div>

        <!-- Terminal instances -->
        <div class="flex-1 min-h-0 relative">
          <div
            v-for="tab in terminalTabs"
            :key="tab.id"
            class="absolute inset-0"
            :class="activeTerminalId === tab.id ? 'z-10 visible' : 'z-0 invisible'"
          >
            <CursorTerminal
              v-if="projectRoot"
              :ref="(el: any) => setTerminalRef(tab.id, el)"
              :repo-path="projectRoot"
              :visible="activeTerminalId === tab.id"
              :session-id="tab.sessionId"
            />
          </div>

          <div
            v-if="terminalTabs.length === 0"
            class="absolute inset-0 flex items-center justify-center"
          >
            <button
              class="flex flex-col items-center gap-3 px-8 py-6 rounded-2xl border border-dashed border-white/10 hover:border-indigo-400/50 hover:bg-white/[0.02] transition-all group"
              @click="addTerminalTab"
            >
              <div class="i-carbon-terminal w-10 h-10 text-gray-500 group-hover:text-indigo-400 transition-colors" />
              <div class="text-center">
                <p class="text-[13px] text-gray-300 font-medium">新建 Cursor Agent 终端</p>
                <p class="text-[11px] text-gray-500 mt-1">cwd: <span class="font-mono">{{ projectRoot || '...' }}</span></p>
                <p class="text-[10px] text-gray-600 mt-2">快捷键 ⌘T</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- Right sidebar: sessions -->
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0 translate-x-4"
        leave-to-class="opacity-0 translate-x-4"
      >
        <div
          v-if="sidebarOpen"
          class="w-[360px] shrink-0 flex flex-col border-l border-gray-200 dark:border-white/[0.06] bg-[#f7f7f9] dark:bg-[#1a1a1e]"
        >
          <!-- Sidebar header -->
          <div class="shrink-0 px-4 pt-4 pb-3 border-b border-gray-100 dark:border-white/[0.04]">
            <div class="flex items-center gap-2 mb-3">
              <div class="i-carbon-data-base w-3.5 h-3.5 text-gray-400 opacity-60" />
              <h2 class="text-[12px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Agent 会话</h2>
              <span class="text-[11px] text-gray-400 bg-gray-100 dark:bg-white/5 px-1.5 py-0.5 rounded-md tabular-nums">
                {{ sessionsTotal > 0 ? `${sessions.length}/${sessionsTotal}` : sessions.length }}
              </span>
              <button
                class="ml-auto p-1 rounded hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                title="刷新"
                @click="loadSessions(true)"
              >
                <div class="i-carbon-renew w-3.5 h-3.5 text-gray-400" :class="loadingSessions && 'animate-spin'" />
              </button>
            </div>
            <div class="relative">
              <div class="i-carbon-search w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                v-model="sessionQuery"
                placeholder="搜索 sessionId / 首轮内容"
                class="w-full pl-8 pr-2 py-1.5 rounded-md bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] text-[12px] outline-none focus:border-indigo-400 dark:focus:border-indigo-500/40 transition-colors"
              >
            </div>
          </div>

          <!-- Sidebar list -->
          <div
            class="flex-1 overflow-y-auto px-3 py-3"
            @scroll.passive="onSessionsScroll"
          >
            <div v-if="loadingSessions && sessions.length === 0" class="flex items-center justify-center py-8 text-[12px] text-gray-400">
              <div class="i-carbon-circle-dash w-4 h-4 animate-spin mr-2" />
              扫描会话文件...
            </div>

            <div v-else-if="filteredSessions.length > 0" class="space-y-2">
              <div
                v-for="session in filteredSessions"
                :key="session.sessionId"
                class="group p-3 bg-white dark:bg-[#28282c] rounded-lg border border-gray-100 dark:border-white/[0.04] transition-all cursor-pointer hover:border-indigo-200 dark:hover:border-indigo-500/30 hover:shadow-sm"
                @click="openSession(session)"
              >
                <div class="flex items-start gap-2">
                  <div class="shrink-0 w-7 h-7 rounded-md bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center mt-0.5">
                    <div class="i-carbon-chat w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-[11px] font-mono text-gray-700 dark:text-gray-300 truncate">
                      {{ session.sessionId }}
                    </p>
                    <p
                      v-if="session.firstTurnPreview"
                      class="mt-1 text-[12px] text-gray-700 dark:text-gray-200 leading-snug line-clamp-2"
                    >
                      {{ session.firstTurnPreview }}
                    </p>
                    <p v-else class="mt-1 text-[12px] text-gray-400 italic">（无首轮内容）</p>
                  </div>
                </div>
                <div class="flex items-center gap-2 mt-2 text-[10px] text-gray-500">
                  <span class="px-1.5 py-0.5 rounded font-medium bg-gray-100 dark:bg-white/5">
                    {{ sessionProviderLabel(session.provider) }}
                  </span>
                  <span class="tabular-nums">{{ formatFileSize(session.sizeBytes) }}</span>
                  <span class="text-gray-300 dark:text-gray-600">·</span>
                  <span class="tabular-nums">{{ timeAgo(session.modifiedAt) }}</span>
                  <button
                    class="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-indigo-500 dark:text-indigo-400 opacity-0 group-hover:opacity-100 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-all"
                    title="在新终端恢复"
                    @click.stop="resumeSession(session)"
                  >
                    <div class="i-carbon-play w-3 h-3" />
                    恢复
                  </button>
                </div>
              </div>

              <div v-if="loadingMoreSessions" class="flex items-center justify-center py-3 text-[11px] text-gray-400">
                <div class="i-carbon-circle-dash w-3.5 h-3.5 animate-spin mr-2" />
                加载更多...
              </div>
              <button
                v-else-if="!sessionQuery.trim() && sessions.length < sessionsTotal"
                type="button"
                class="w-full py-2 rounded-lg text-[11px] text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors"
                @click="loadSessions(false)"
              >
                加载更多（{{ sessions.length }} / {{ sessionsTotal }}）
              </button>
            </div>

            <div v-else class="flex flex-col items-center justify-center py-12 text-gray-300 dark:text-gray-600">
              <div class="i-carbon-data-base w-8 h-8 mb-2 opacity-30" />
              <p class="text-[12px]">{{ sessionQuery ? '无匹配会话' : '暂无会话' }}</p>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Session detail drawer -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="showSessionDetail"
          class="fixed inset-0 z-50 flex"
        >
          <div class="absolute inset-0 bg-black/40 backdrop-blur-[2px]" @click="closeSessionDetail" />
          <div class="relative ml-auto w-full max-w-3xl h-full bg-white dark:bg-[#1e1e22] shadow-2xl flex flex-col">
            <!-- Header -->
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
                    {{ sessionProviderLabel(selectedSession.provider) }}
                  </span>
                  <span v-if="transcriptFormat" class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400">
                    {{ transcriptFormat }}
                  </span>
                  <span v-if="transcriptTurns.length" class="text-[11px] text-gray-400">
                    {{ transcriptTurns.length }} 轮对话
                  </span>
                  <span v-if="selectedSession" class="text-[11px] text-gray-400">
                    {{ formatDate(selectedSession.modifiedAt) }}
                  </span>
                </div>
              </div>
              <button
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
                @click="resumeFromDrawer"
              >
                <div class="i-carbon-play w-3.5 h-3.5" />
                在新终端恢复
              </button>
            </div>

            <!-- Body -->
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

                  <div class="space-y-2 pl-3 border-l-2 border-emerald-200 dark:border-emerald-500/20">
                    <template v-for="(block, bIdx) in turn.blocks" :key="bIdx">
                      <div v-if="block.kind === 'text'" class="rounded-xl px-4 py-3 bg-white dark:bg-[#28282c] border border-gray-100 dark:border-white/[0.04] shadow-sm shadow-black/[0.02] dark:shadow-none">
                        <div class="prose-chat text-[13px] leading-relaxed text-gray-700 dark:text-gray-200" v-html="md.render(block.text)" />
                      </div>

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

            <!-- Footer -->
            <div v-if="transcriptFilePath" class="shrink-0 px-5 py-2 border-t border-gray-100 dark:border-white/[0.03] text-[10px] font-mono text-gray-400 dark:text-gray-600 truncate">
              {{ transcriptFilePath }}
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
