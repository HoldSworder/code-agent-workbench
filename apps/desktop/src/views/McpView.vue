<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { rpc } from '../composables/use-sidecar'

interface McpServer {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  command: string | null
  args: string
  env: string
  url: string | null
  headers: string
  enabled: number
  created_at: string
  updated_at: string
}

const servers = ref<McpServer[]>([])
const loading = ref(false)

const showEditor = ref(false)
const editingServer = ref<McpServer | null>(null)
const saving = ref(false)

const form = ref({
  name: '',
  description: '',
  transport: 'stdio' as 'stdio' | 'http' | 'sse',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
})

// ── Test connectivity ──
const testingIds = ref<Set<string>>(new Set())
const testResults = ref<Map<string, { ok: boolean, error?: string }>>(new Map())

async function testServer(server: McpServer) {
  testingIds.value.add(server.id)
  testResults.value.delete(server.id)
  try {
    const result = await rpc<{ ok: boolean, error?: string }>('mcp.test', { id: server.id })
    testResults.value.set(server.id, result)
  } catch (err: any) {
    testResults.value.set(server.id, { ok: false, error: err?.message || 'RPC failed' })
  } finally {
    testingIds.value.delete(server.id)
  }
}

// ── JSON import ──
const showJsonImport = ref(false)
const jsonInput = ref('')
const jsonError = ref('')

function openJsonImport() {
  jsonInput.value = ''
  jsonError.value = ''
  showJsonImport.value = true
}

const parsedJsonServers = computed(() => {
  if (!jsonInput.value.trim()) return []
  try {
    const raw = JSON.parse(jsonInput.value.trim())
    return extractServersFromJson(raw)
  } catch {
    return []
  }
})

interface ParsedServer {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

function extractServersFromJson(raw: any): ParsedServer[] {
  const servers: ParsedServer[] = []

  const entries = raw.mcpServers ?? raw.servers ?? raw
  if (typeof entries !== 'object' || entries === null) return []

  if (Array.isArray(entries)) {
    for (const item of entries) {
      if (item.name) servers.push(normalizeServerEntry(item.name, item))
    }
    return servers
  }

  for (const [name, cfg] of Object.entries(entries)) {
    if (typeof cfg === 'object' && cfg !== null) {
      servers.push(normalizeServerEntry(name, cfg as any))
    }
  }
  return servers
}

function normalizeServerEntry(name: string, cfg: any): ParsedServer {
  if (cfg.url) {
    const transport = cfg.transport === 'sse' ? 'sse' : 'http'
    return { name, transport, url: cfg.url, headers: cfg.headers }
  }
  return {
    name,
    transport: 'stdio',
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
  }
}

async function importJsonServers() {
  const parsed = parsedJsonServers.value
  if (parsed.length === 0) {
    jsonError.value = '未识别到有效的 MCP Server 配置'
    return
  }
  jsonError.value = ''
  try {
    for (const srv of parsed) {
      await rpc('mcp.create', {
        name: srv.name,
        description: '',
        transport: srv.transport,
        command: srv.command,
        args: srv.args ?? [],
        env: srv.env ?? {},
        url: srv.url,
        headers: srv.headers ?? {},
      })
    }
    showJsonImport.value = false
    await loadData()
  } catch (err: any) {
    jsonError.value = err?.message || '导入失败'
  }
}

// ── CRUD ──
async function loadData() {
  loading.value = true
  try {
    servers.value = await rpc<McpServer[]>('mcp.list')
  } catch (err) {
    console.error('Failed to load MCP data:', err)
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

function openCreate() {
  editingServer.value = null
  form.value = { name: '', description: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' }
  showEditor.value = true
}

function openEdit(server: McpServer) {
  editingServer.value = server
  form.value = {
    name: server.name,
    description: server.description,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args === '[]' ? '' : server.args,
    env: server.env === '{}' ? '' : server.env,
    url: server.url ?? '',
    headers: server.headers === '{}' ? '' : server.headers,
  }
  showEditor.value = true
}

function closeEditor() {
  showEditor.value = false
  editingServer.value = null
}

async function saveServer() {
  saving.value = true
  try {
    const payload: Record<string, unknown> = {
      name: form.value.name,
      description: form.value.description,
      transport: form.value.transport,
    }
    if (form.value.transport === 'stdio') {
      payload.command = form.value.command || undefined
      payload.args = form.value.args ? JSON.parse(form.value.args) : []
      payload.env = form.value.env ? JSON.parse(form.value.env) : {}
    } else {
      payload.url = form.value.url || undefined
      payload.headers = form.value.headers ? JSON.parse(form.value.headers) : {}
    }

    if (editingServer.value) {
      await rpc('mcp.update', { id: editingServer.value.id, ...payload })
    } else {
      await rpc('mcp.create', payload)
    }
    closeEditor()
    await loadData()
  } catch (err) {
    console.error('Failed to save MCP server:', err)
  } finally {
    saving.value = false
  }
}

async function deleteServer(id: string) {
  try {
    await rpc('mcp.delete', { id })
    await loadData()
  } catch (err) {
    console.error('Failed to delete MCP server:', err)
  }
}

async function toggleServer(id: string) {
  try {
    await rpc<McpServer>('mcp.toggle', { id })
    await loadData()
  } catch (err) {
    console.error('Failed to toggle MCP server:', err)
  }
}

const transportLabel: Record<string, string> = {
  stdio: 'Stdio',
  http: 'HTTP',
  sse: 'SSE',
}

const transportColor: Record<string, string> = {
  stdio: 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400',
  http: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  sse: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400',
}
</script>

<template>
  <div class="p-8 max-w-2xl mx-auto">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">MCP 管理</h1>
        <p class="text-[12px] text-gray-400 mt-0.5">注册按需启用的 MCP Server，在各阶段按需绑定使用</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
          @click="openJsonImport"
        >
          <div class="i-carbon-document-import w-3.5 h-3.5" />
          粘贴 JSON
        </button>
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20"
          @click="openCreate"
        >
          <div class="i-carbon-add w-3.5 h-3.5" />
          添加
        </button>
      </div>
    </div>

    <!-- 按需加载说明 -->
    <div class="mb-5 px-3.5 py-2.5 rounded-lg bg-amber-50/80 dark:bg-amber-500/5 border border-amber-200/60 dark:border-amber-500/10">
      <div class="flex items-start gap-2">
        <div class="i-carbon-information w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
        <div class="text-[11.5px] text-amber-700 dark:text-amber-400/90 leading-relaxed">
          <span class="font-medium">按需加载模式</span> — 此处注册的 MCP Server 不会全局常驻运行。它们仅在工作流阶段中被绑定时才会按需启动，任务结束后自动释放，避免不必要的资源占用。
        </div>
      </div>
    </div>

    <div v-if="loading && servers.length === 0" class="flex items-center justify-center py-16">
      <div class="flex items-center gap-2 text-gray-400 text-[13px]">
        <div class="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
        加载中…
      </div>
    </div>

    <div v-else-if="servers.length === 0" class="text-center py-20">
      <div class="i-carbon-plug w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
      <p class="text-[13px] text-gray-400">暂无按需 MCP Server</p>
      <p class="text-[12px] text-gray-300 dark:text-gray-500 mt-1">点击"添加"手动注册，或"粘贴 JSON"快速导入</p>
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="server in servers"
        :key="server.id"
        class="bg-white dark:bg-[#28282c] rounded-xl shadow-sm shadow-black/[0.04] dark:shadow-none px-4 py-3 group transition-all duration-150 hover:shadow-md hover:shadow-black/[0.06]"
      >
        <div class="flex items-center gap-3">
          <button
            class="w-9 h-9 rounded-full flex items-center justify-center transition-all duration-150 shrink-0"
            :class="server.enabled
              ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/30'
              : 'bg-gray-100 dark:bg-white/5 text-gray-300 dark:text-gray-600'"
            @click="toggleServer(server.id)"
          >
            <div class="i-carbon-power w-4 h-4" />
          </button>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-[13px] font-medium text-gray-800 dark:text-gray-100 truncate">{{ server.name }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" :class="transportColor[server.transport]">
                {{ transportLabel[server.transport] }}
              </span>
            </div>
            <p v-if="server.description" class="text-[11px] text-gray-400 mt-0.5 truncate">{{ server.description }}</p>
            <p v-if="server.transport === 'stdio' && server.command" class="text-[10px] text-gray-300 dark:text-gray-600 font-mono mt-0.5 truncate">
              {{ server.command }}
            </p>
            <p v-else-if="server.url" class="text-[10px] text-gray-300 dark:text-gray-600 font-mono mt-0.5 truncate">
              {{ server.url }}
            </p>

            <!-- Test result -->
            <Transition
              enter-active-class="transition-all duration-200"
              leave-active-class="transition-all duration-150"
              enter-from-class="opacity-0 -translate-y-1"
              leave-to-class="opacity-0 -translate-y-1"
            >
              <div v-if="testResults.has(server.id)" class="mt-1">
                <span
                  v-if="testResults.get(server.id)?.ok"
                  class="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"
                >
                  <div class="i-carbon-checkmark-filled w-3 h-3" />
                  连通正常
                </span>
                <span
                  v-else
                  class="inline-flex items-center gap-1 text-[10px] text-red-500 dark:text-red-400"
                >
                  <div class="i-carbon-close-filled w-3 h-3" />
                  {{ testResults.get(server.id)?.error || '连接失败' }}
                </span>
              </div>
            </Transition>
          </div>

          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              class="w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
              title="测试连通"
              :disabled="testingIds.has(server.id)"
              @click="testServer(server)"
            >
              <div v-if="testingIds.has(server.id)" class="w-3.5 h-3.5 border-2 border-gray-300 border-t-emerald-500 rounded-full animate-spin" />
              <div v-else class="i-carbon-connection-signal w-3.5 h-3.5" />
            </button>
            <button
              class="w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
              @click="openEdit(server)"
            >
              <div class="i-carbon-edit w-3.5 h-3.5" />
            </button>
            <button
              class="w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
              @click="deleteServer(server.id)"
            >
              <div class="i-carbon-trash-can w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Editor modal -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="showEditor" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="closeEditor">
        <div class="w-[480px] max-h-[80vh] bg-white dark:bg-[#28282c] rounded-2xl shadow-2xl overflow-y-auto">
          <div class="px-6 py-5 border-b border-gray-100 dark:border-white/5">
            <h2 class="text-[15px] font-semibold">
              {{ editingServer ? '编辑 MCP Server' : '添加 MCP Server' }}
            </h2>
          </div>

          <div class="px-6 py-5 space-y-4">
            <div>
              <label class="text-[12px] font-medium text-gray-500 mb-1 block">名称</label>
              <input
                v-model="form.name"
                class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                placeholder="e.g. feishu-project"
              >
            </div>

            <div>
              <label class="text-[12px] font-medium text-gray-500 mb-1 block">描述</label>
              <input
                v-model="form.description"
                class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                placeholder="可选"
              >
            </div>

            <div>
              <label class="text-[12px] font-medium text-gray-500 mb-1 block">Transport</label>
              <div class="flex gap-2">
                <button
                  v-for="t in (['stdio', 'http', 'sse'] as const)"
                  :key="t"
                  class="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
                  :class="form.transport === t
                    ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
                    : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10'"
                  @click="form.transport = t"
                >
                  {{ transportLabel[t] }}
                </button>
              </div>
            </div>

            <template v-if="form.transport === 'stdio'">
              <div>
                <label class="text-[12px] font-medium text-gray-500 mb-1 block">Command</label>
                <input
                  v-model="form.command"
                  class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                  placeholder="e.g. npx -y @anthropic/mcp-server"
                >
              </div>
              <div>
                <label class="text-[12px] font-medium text-gray-500 mb-1 block">Args (JSON array)</label>
                <input
                  v-model="form.args"
                  class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                  placeholder='["--port", "8080"]'
                >
              </div>
              <div>
                <label class="text-[12px] font-medium text-gray-500 mb-1 block">Env (JSON object)</label>
                <input
                  v-model="form.env"
                  class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                  placeholder='{"API_KEY": "..."}'
                >
              </div>
            </template>

            <template v-else>
              <div>
                <label class="text-[12px] font-medium text-gray-500 mb-1 block">URL</label>
                <input
                  v-model="form.url"
                  class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                  placeholder="https://mcp.example.com/mcp"
                >
              </div>
              <div>
                <label class="text-[12px] font-medium text-gray-500 mb-1 block">Headers (JSON object)</label>
                <input
                  v-model="form.headers"
                  class="w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 text-[13px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors"
                  placeholder='{"Authorization": "Bearer ..."}'
                >
              </div>
            </template>
          </div>

          <div class="px-6 py-4 border-t border-gray-100 dark:border-white/5 flex items-center justify-end gap-2">
            <button
              class="px-4 py-1.5 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              @click="closeEditor"
            >
              取消
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-[13px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20 disabled:opacity-50"
              :disabled="!form.name || saving"
              @click="saveServer"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- JSON import modal -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="showJsonImport" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" @click.self="showJsonImport = false">
        <div class="w-[520px] max-h-[80vh] bg-white dark:bg-[#28282c] rounded-2xl shadow-2xl overflow-y-auto">
          <div class="px-6 py-5 border-b border-gray-100 dark:border-white/5">
            <h2 class="text-[15px] font-semibold">粘贴 MCP JSON 配置</h2>
            <p class="text-[11.5px] text-gray-400 mt-1 leading-relaxed">
              支持 Claude Desktop / Cursor 格式，粘贴后自动解析并批量导入
            </p>
          </div>

          <div class="px-6 py-5 space-y-4">
            <div>
              <textarea
                v-model="jsonInput"
                class="w-full h-48 px-3 py-2.5 rounded-lg bg-gray-50 dark:bg-white/5 text-[12px] font-mono border border-gray-200 dark:border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20 transition-colors resize-none leading-relaxed"
                placeholder='{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}'
                spellcheck="false"
              />
            </div>

            <!-- Preview -->
            <div v-if="parsedJsonServers.length > 0" class="space-y-1.5">
              <p class="text-[11px] font-medium text-gray-500">
                识别到 {{ parsedJsonServers.length }} 个 Server：
              </p>
              <div
                v-for="s in parsedJsonServers"
                :key="s.name"
                class="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50/80 dark:bg-emerald-500/5 border border-emerald-200/50 dark:border-emerald-500/10"
              >
                <div class="i-carbon-checkmark-filled w-3 h-3 text-emerald-500 shrink-0" />
                <span class="text-[12px] font-medium text-gray-700 dark:text-gray-200">{{ s.name }}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0" :class="transportColor[s.transport]">
                  {{ transportLabel[s.transport] }}
                </span>
                <span v-if="s.command" class="text-[10px] text-gray-400 font-mono truncate">{{ s.command }}</span>
                <span v-else-if="s.url" class="text-[10px] text-gray-400 font-mono truncate">{{ s.url }}</span>
              </div>
            </div>

            <div v-else-if="jsonInput.trim() && parsedJsonServers.length === 0" class="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50/80 dark:bg-red-500/5 border border-red-200/50 dark:border-red-500/10">
              <div class="i-carbon-warning-filled w-3 h-3 text-red-400 shrink-0" />
              <span class="text-[11px] text-red-600 dark:text-red-400">JSON 格式无法识别，请检查后重试</span>
            </div>

            <p v-if="jsonError" class="text-[11px] text-red-500">{{ jsonError }}</p>
          </div>

          <div class="px-6 py-4 border-t border-gray-100 dark:border-white/5 flex items-center justify-end gap-2">
            <button
              class="px-4 py-1.5 rounded-lg text-[13px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
              @click="showJsonImport = false"
            >
              取消
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-[13px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20 disabled:opacity-50"
              :disabled="parsedJsonServers.length === 0"
              @click="importJsonServers"
            >
              导入 {{ parsedJsonServers.length > 0 ? `${parsedJsonServers.length} 个` : '' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
