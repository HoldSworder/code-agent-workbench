<script setup lang="ts">
import { ref, onMounted } from 'vue'
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
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">MCP 管理</h1>
        <p class="text-[12px] text-gray-400 mt-0.5">注册按需启用的 MCP Server，在各阶段按需绑定使用</p>
      </div>
      <button
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-sm shadow-indigo-500/20"
        @click="openCreate"
      >
        <div class="i-carbon-add w-3.5 h-3.5" />
        添加
      </button>
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
      <p class="text-[12px] text-gray-300 dark:text-gray-500 mt-1">点击"添加"注册你的第一个按需 MCP Server</p>
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
          </div>

          <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
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
  </div>
</template>
