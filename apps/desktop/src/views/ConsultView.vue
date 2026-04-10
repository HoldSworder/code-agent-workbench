<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { rpc } from '../composables/use-sidecar'
import AgentSelector from '../components/AgentSelector.vue'

// --- Config ---
const consultProvider = ref('cursor-cli')
const consultModel = ref('')
const consultBinaryPath = ref('')
const consultPort = ref('3100')
const consultRunning = ref(false)
const consultLocalIp = ref<string | null>(null)
const savingConsult = ref(false)
const consultToggling = ref(false)
const configCollapsed = ref(false)

// --- Sessions ---
interface ConsultSessionSummary {
  id: string
  repoId: string
  repoPath: string
  clientIp: string | null
  messageCount: number
  createdAt: number
  lastActiveAt: number
}
interface ConsultMsg { role: 'user' | 'assistant', content: string, timestamp: number }

const sessions = ref<ConsultSessionSummary[]>([])
const sessionsLoading = ref(false)
const expandedId = ref<string | null>(null)
const expandedMsgs = ref<ConsultMsg[]>([])
const expandedLoading = ref(false)

onMounted(async () => {
  try {
    const all = await rpc<Record<string, string>>('settings.getAll')
    if (all['consult.provider']) consultProvider.value = all['consult.provider']
    if (all['consult.model']) consultModel.value = all['consult.model']
    if (all['consult.binaryPath']) consultBinaryPath.value = all['consult.binaryPath']
    if (all['consult.port']) consultPort.value = all['consult.port']

    const status = await rpc<{ running: boolean, port: number | null, localIp: string | null }>('consult.status')
    consultRunning.value = status.running
    consultLocalIp.value = status.localIp
    if (status.running) {
      configCollapsed.value = true
      loadSessions()
    }
  } catch {}
})

async function saveConfig() {
  savingConsult.value = true
  try {
    await rpc('settings.set', { key: 'consult.provider', value: consultProvider.value })
    if (consultModel.value)
      await rpc('settings.set', { key: 'consult.model', value: consultModel.value })
    if (consultBinaryPath.value)
      await rpc('settings.set', { key: 'consult.binaryPath', value: consultBinaryPath.value })
    await rpc('settings.set', { key: 'consult.port', value: consultPort.value })
  } finally {
    savingConsult.value = false
  }
}

async function toggleServer() {
  consultToggling.value = true
  try {
    if (consultRunning.value) {
      await rpc('consult.stop')
      consultRunning.value = false
      consultLocalIp.value = null
      sessions.value = []
    } else {
      await saveConfig()
      const status = await rpc<{ running: boolean, port: number | null, localIp: string | null }>('consult.start', { port: Number(consultPort.value) || 3100 })
      consultRunning.value = status.running
      consultLocalIp.value = status.localIp
      configCollapsed.value = true
      loadSessions()
    }
  } catch (e: any) {
    console.error('Consult toggle failed:', e)
  } finally {
    consultToggling.value = false
  }
}

async function loadSessions() {
  if (!consultRunning.value) { sessions.value = []; return }
  sessionsLoading.value = true
  try {
    sessions.value = await rpc<ConsultSessionSummary[]>('consult.listSessions')
  } catch { sessions.value = [] }
  finally { sessionsLoading.value = false }
}

async function toggleExpand(sessionId: string) {
  if (expandedId.value === sessionId) {
    expandedId.value = null
    expandedMsgs.value = []
    return
  }
  expandedId.value = sessionId
  expandedLoading.value = true
  try {
    expandedMsgs.value = await rpc<ConsultMsg[]>('consult.getSessionMessages', { sessionId })
  } catch { expandedMsgs.value = [] }
  finally { expandedLoading.value = false }
}

function openUrl() {
  const url = `http://${consultLocalIp.value ?? 'localhost'}:${consultPort.value}`
  window.open(url, '_blank')
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function repoName(path: string): string {
  return path.split('/').pop() ?? path
}

const inputClass = 'w-full h-9 px-3 py-2 rounded-xl bg-[#fafafa] dark:bg-white/[0.04] text-[13px] border border-gray-200 dark:border-white/[0.08] placeholder-gray-300 dark:placeholder-gray-600 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 focus:bg-white dark:focus:bg-white/[0.06] outline-none transition-all duration-150'
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Top bar: title + status + toggle -->
    <div class="shrink-0 px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <h1 class="text-lg font-semibold tracking-tight">咨询模式</h1>
        <!-- Status pill -->
        <div v-if="consultRunning" class="flex items-center gap-2 px-3 py-1 rounded-full bg-green-50 dark:bg-green-500/8">
          <span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <button
            class="text-[12px] font-mono text-green-600 dark:text-green-400 hover:underline inline-flex items-center gap-1"
            @click="openUrl"
          >
            http://{{ consultLocalIp ?? 'localhost' }}:{{ consultPort }}
            <span class="i-carbon-launch w-3 h-3 opacity-50" />
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="consultRunning"
          class="text-[12px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-1 px-2 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          @click="configCollapsed = !configCollapsed"
        >
          <div class="i-carbon-settings w-3.5 h-3.5" />
          {{ configCollapsed ? '展开配置' : '收起配置' }}
        </button>
        <button
          class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-150"
          :class="consultRunning
            ? 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/15'
            : 'bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/15'"
          :disabled="consultToggling"
          @click="toggleServer"
        >
          <div v-if="consultToggling" class="i-carbon-circle-dash w-3.5 h-3.5 animate-spin" />
          <div v-else-if="consultRunning" class="i-carbon-stop w-3.5 h-3.5" />
          <div v-else class="i-carbon-play w-3.5 h-3.5" />
          {{ consultToggling ? '处理中...' : consultRunning ? '停止' : '启动' }}
        </button>
      </div>
    </div>

    <!-- Body: config (collapsible) + sessions (fills remaining) -->
    <div class="flex-1 min-h-0 flex flex-col px-6 pb-4 gap-4 overflow-hidden">
      <!-- Config section (collapsible) -->
      <div
        class="shrink-0 overflow-hidden transition-all duration-300 ease-in-out"
        :style="{ maxHeight: configCollapsed ? '0px' : '400px', opacity: configCollapsed ? 0 : 1 }"
      >
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <!-- Provider + Model -->
          <section class="card">
            <div class="card-header">
              <div class="w-7 h-7 rounded-md bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center shrink-0">
                <div class="i-carbon-bot w-3.5 h-3.5 text-indigo-500" />
              </div>
              <h3 class="card-title">咨询 Agent</h3>
            </div>
            <div class="p-3">
              <AgentSelector
                :provider="consultProvider"
                :model="consultModel"
                @update:provider="consultProvider = $event"
                @update:model="consultModel = $event"
              />
            </div>
          </section>

          <!-- CLI config -->
          <section class="card">
            <div class="card-header">
              <div class="w-7 h-7 rounded-md bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center shrink-0">
                <div class="i-carbon-terminal w-3.5 h-3.5 text-emerald-500" />
              </div>
              <h3 class="card-title">CLI 配置</h3>
            </div>
            <div class="p-3 space-y-3">
              <div>
                <label class="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Binary 路径</label>
                <div class="relative">
                  <div class="absolute left-2.5 top-1/2 -translate-y-1/2 i-carbon-terminal w-3 h-3 text-gray-300 dark:text-gray-600" />
                  <input
                    v-model="consultBinaryPath"
                    type="text"
                    :placeholder="consultProvider === 'claude-code' ? 'claude' : consultProvider === 'codex' ? 'codex' : 'agent'"
                    :class="[inputClass, 'pl-7 !h-8 !text-[12px]']"
                  >
                </div>
              </div>
              <div>
                <label class="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">端口</label>
                <div class="relative">
                  <div class="absolute left-2.5 top-1/2 -translate-y-1/2 i-carbon-network-4 w-3 h-3 text-gray-300 dark:text-gray-600" />
                  <input v-model="consultPort" type="text" placeholder="3100" :class="[inputClass, 'pl-7 !h-8 !text-[12px]']">
                </div>
              </div>
            </div>
          </section>

          <!-- Save -->
          <section class="card flex flex-col">
            <div class="card-header">
              <div class="w-7 h-7 rounded-md bg-gray-100 dark:bg-white/5 flex items-center justify-center shrink-0">
                <div class="i-carbon-save w-3.5 h-3.5 text-gray-400" />
              </div>
              <h3 class="card-title">操作</h3>
            </div>
            <div class="p-3 flex-1 flex flex-col justify-center gap-2">
              <button
                class="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg bg-indigo-500 text-white text-[12px] font-medium hover:bg-indigo-600 active:scale-[0.98] transition-all duration-150 disabled:opacity-50"
                :disabled="savingConsult"
                @click="saveConfig"
              >
                <div v-if="savingConsult" class="i-carbon-circle-dash w-3.5 h-3.5 animate-spin" />
                <div v-else class="i-carbon-checkmark w-3.5 h-3.5" />
                {{ savingConsult ? '保存中...' : '保存配置' }}
              </button>
              <p class="text-[11px] text-gray-400 dark:text-gray-600 text-center">只读模式，不会修改代码</p>
            </div>
          </section>
        </div>
      </div>

      <!-- Sessions panel (fills all remaining space) -->
      <section class="card flex-1 min-h-0 flex flex-col">
        <div class="card-header shrink-0">
          <div class="w-7 h-7 rounded-md bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center shrink-0">
            <div class="i-carbon-recently-viewed w-3.5 h-3.5 text-violet-500" />
          </div>
          <div class="flex-1">
            <h3 class="card-title">咨询记录</h3>
          </div>
          <span class="text-[11px] text-gray-400 dark:text-gray-500">{{ sessions.length }} 个会话</span>
          <button
            v-if="consultRunning"
            class="text-[12px] text-indigo-500 hover:text-indigo-600 flex items-center gap-1 px-2 py-1 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-500/8 transition-colors"
            :disabled="sessionsLoading"
            @click="loadSessions"
          >
            <div class="i-carbon-renew w-3.5 h-3.5" :class="sessionsLoading && 'animate-spin'" />
            刷新
          </button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto p-3">
          <!-- Not running -->
          <div v-if="!consultRunning" class="flex flex-col items-center justify-center h-full text-center">
            <div class="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-3">
              <div class="i-carbon-power w-6 h-6 text-gray-300 dark:text-gray-600" />
            </div>
            <p class="text-[13px] text-gray-400 font-medium">服务未启动</p>
            <p class="text-[11px] text-gray-300 dark:text-gray-600 mt-1">启动咨询服务后可查看会话记录</p>
          </div>

          <!-- Loading -->
          <div v-else-if="sessionsLoading && sessions.length === 0" class="flex flex-col items-center justify-center h-full">
            <div class="i-carbon-circle-dash w-6 h-6 animate-spin text-gray-300 mb-2" />
            <p class="text-[13px] text-gray-400">加载中...</p>
          </div>

          <!-- Empty -->
          <div v-else-if="sessions.length === 0" class="flex flex-col items-center justify-center h-full text-center">
            <div class="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-3">
              <div class="i-carbon-chat w-6 h-6 text-gray-300 dark:text-gray-600" />
            </div>
            <p class="text-[13px] text-gray-400 font-medium">暂无咨询记录</p>
            <p class="text-[11px] text-gray-300 dark:text-gray-600 mt-1">有用户发起咨询后，记录将显示在这里</p>
          </div>

          <!-- Session list -->
          <div v-else class="space-y-1">
            <div
              v-for="sess in sessions"
              :key="sess.id"
              class="rounded-lg transition-colors"
              :class="expandedId === sess.id ? 'bg-gray-50 dark:bg-white/[0.02]' : ''"
            >
              <!-- Session row -->
              <button
                class="w-full text-left px-3 py-3 hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors rounded-lg"
                @click="toggleExpand(sess.id)"
              >
                <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    :class="expandedId === sess.id
                      ? 'bg-indigo-100 dark:bg-indigo-500/15'
                      : 'bg-gray-100 dark:bg-white/5'"
                  >
                    <div class="i-carbon-folder-details w-4 h-4"
                      :class="expandedId === sess.id ? 'text-indigo-500' : 'text-gray-400'"
                    />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-[13px] font-semibold text-gray-700 dark:text-gray-200 truncate">{{ repoName(sess.repoPath) }}</span>
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-500 dark:text-gray-400 font-mono shrink-0">{{ sess.clientIp ?? '未知' }}</span>
                    </div>
                    <div class="flex items-center gap-3 mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                      <span class="inline-flex items-center gap-1">
                        <span class="i-carbon-chat w-3 h-3" />
                        {{ sess.messageCount }} 条消息
                      </span>
                      <span class="inline-flex items-center gap-1">
                        <span class="i-carbon-time w-3 h-3" />
                        {{ fmtTime(sess.lastActiveAt) }}
                      </span>
                    </div>
                  </div>
                  <div
                    class="i-carbon-chevron-down w-3.5 h-3.5 text-gray-300 transition-transform duration-200"
                    :class="expandedId === sess.id && 'rotate-180'"
                  />
                </div>
              </button>

              <!-- Expanded messages -->
              <div v-if="expandedId === sess.id" class="px-3 pb-3">
                <div v-if="expandedLoading" class="py-4 text-center">
                  <div class="i-carbon-circle-dash w-4 h-4 animate-spin mx-auto text-gray-300" />
                </div>
                <div v-else-if="expandedMsgs.length === 0" class="py-4 text-center text-[12px] text-gray-400">
                  暂无消息
                </div>
                <div v-else class="space-y-2">
                  <div
                    v-for="(msg, idx) in expandedMsgs"
                    :key="idx"
                    class="rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed"
                    :class="msg.role === 'user'
                      ? 'bg-indigo-50 dark:bg-indigo-500/8 text-gray-700 dark:text-gray-200'
                      : 'bg-white dark:bg-white/[0.03] text-gray-600 dark:text-gray-300'"
                  >
                    <div class="flex items-center gap-1.5 mb-1.5">
                      <span
                        class="w-5 h-5 rounded-md flex items-center justify-center"
                        :class="msg.role === 'user'
                          ? 'bg-indigo-500/10 dark:bg-indigo-500/15'
                          : 'bg-gray-200/60 dark:bg-white/5'"
                      >
                        <span :class="msg.role === 'user' ? 'i-carbon-user' : 'i-carbon-bot'" class="w-3 h-3"
                          :style="{ color: msg.role === 'user' ? '#6366f1' : '#9ca3af' }"
                        />
                      </span>
                      <span class="text-[11px] font-medium" :class="msg.role === 'user' ? 'text-indigo-500' : 'text-gray-400'">
                        {{ msg.role === 'user' ? '用户' : '助手' }}
                      </span>
                      <span class="text-[10px] text-gray-300 dark:text-gray-600 ml-auto">{{ fmtTime(msg.timestamp) }}</span>
                    </div>
                    <div class="whitespace-pre-wrap break-words text-[12.5px]">{{ msg.content }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: white;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
:is(.dark) .card {
  background: #28282c;
  border-color: rgba(255, 255, 255, 0.04);
  box-shadow: none;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
:is(.dark) .card-header {
  border-bottom-color: rgba(255, 255, 255, 0.04);
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}
:is(.dark) .card-title {
  color: #e5e7eb;
}
</style>
