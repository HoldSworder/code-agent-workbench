<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { rpc } from '../composables/use-sidecar'

type McpTransport = 'stdio' | 'http' | 'sse'
type McpLastTestStatus = 'success' | 'error' | null
type McpAuthType = 'oauth' | null
type McpOAuthAuthState = 'none' | 'required' | 'connected' | 'unsupported' | 'error' | null
type McpOAuthRedirectMode = 'deeplink' | 'loopback' | null
type CapabilitySectionKey = 'tools' | 'resources' | 'prompts'

interface McpCapabilityItem {
  name: string
  description?: string | null
  uri?: string | null
  mimeType?: string | null
  inputSchema?: unknown
  arguments?: unknown
}

interface McpCapabilityGroup {
  count: number
  items: McpCapabilityItem[]
}

interface McpCapabilityDetails {
  protocolVersion?: string | null
  serverInfo?: {
    name?: string
    version?: string
  } | null
  capabilities: Record<CapabilitySectionKey, McpCapabilityGroup>
}

interface McpCapabilitySummary {
  tools: string[]
  resources: string[]
  prompts: string[]
}

interface McpOAuthMetadata {
  resource?: {
    resource?: string
    authorization_servers?: string[]
    scopes_supported?: string[]
  }
  authorizationServer?: {
    issuer?: string
    authorization_endpoint?: string
    token_endpoint?: string
  }
  protectedResourceMetadataUrl?: string
  authorizationServerMetadataUrl?: string
  scopeHint?: string | null
}

interface McpOAuthRegistration {
  client_id?: string
  redirect_uris?: string[]
}

interface RawMcpServer {
  id: string
  name: string
  description: string
  transport: McpTransport
  command: string | null
  args: string
  env: string
  url: string | null
  headers: string
  enabled: number
  last_test_status?: McpLastTestStatus
  last_test_error?: string | null
  last_tested_at?: string | null
  capabilities_json?: string | null
  capabilities_summary?: string | null
  auth_type?: McpAuthType
  oauth_client_id?: string | null
  oauth_scope?: string | null
  oauth_audience?: string | null
  oauth_token_endpoint_auth_method?: string | null
  oauth_access_token?: string | null
  oauth_refresh_token?: string | null
  oauth_token_type?: string | null
  oauth_expires_at?: string | null
  oauth_id_token?: string | null
  oauth_metadata_json?: string | null
  oauth_registration_json?: string | null
  oauth_auth_state?: McpOAuthAuthState
  oauth_redirect_mode?: McpOAuthRedirectMode
  oauth_last_error?: string | null
  oauth_connected_at?: string | null
  created_at: string
  updated_at: string
}

interface McpServer extends Omit<RawMcpServer, 'last_test_status' | 'last_test_error' | 'last_tested_at' | 'capabilities_json' | 'capabilities_summary' | 'oauth_metadata_json'> {
  last_test_status: McpLastTestStatus
  last_test_error: string | null
  last_tested_at: string | null
  capabilities_json: string | null
  capabilities_summary: string | null
  capabilityDetails: McpCapabilityDetails | null
  capabilitySummary: McpCapabilitySummary
  auth_type: McpAuthType
  oauth_client_id: string | null
  oauth_scope: string | null
  oauth_audience: string | null
  oauth_token_endpoint_auth_method: string | null
  oauth_access_token: string | null
  oauth_refresh_token: string | null
  oauth_token_type: string | null
  oauth_expires_at: string | null
  oauth_id_token: string | null
  oauth_metadata_json: string | null
  oauth_registration_json: string | null
  oauth_auth_state: McpOAuthAuthState
  oauth_redirect_mode: McpOAuthRedirectMode
  oauth_last_error: string | null
  oauth_connected_at: string | null
  oauthMetadata: McpOAuthMetadata | null
  oauthRegistration: McpOAuthRegistration | null
}

interface McpTestResult {
  ok: boolean
  error?: string
  testedAt?: string
}

interface McpOAuthStartResult {
  requestId: string
  authUrl: string
  redirectUri: string
  callbackPort: number
  state: string
}

interface McpOAuthPollResult {
  status: 'pending' | 'success' | 'error'
  error?: string
}

interface ParsedServer {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

const capabilitySectionMeta: Array<{ key: CapabilitySectionKey, label: string }> = [
  { key: 'tools', label: 'Tools' },
  { key: 'resources', label: 'Resources' },
  { key: 'prompts', label: 'Prompts' },
]

const transportLabel: Record<McpTransport, string> = {
  stdio: 'Stdio',
  http: 'HTTP',
  sse: 'SSE',
}

const transportColor: Record<McpTransport, string> = {
  stdio: 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400',
  http: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  sse: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400',
}

const servers = ref<McpServer[]>([])
const loading = ref(false)

const showEditor = ref(false)
const editingServer = ref<McpServer | null>(null)
const saving = ref(false)

const form = ref({
  name: '',
  description: '',
  transport: 'stdio' as McpTransport,
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
})

const testingIds = ref(new Set<string>())
const testResults = ref(new Map<string, McpTestResult>())
const expandedIds = ref(new Set<string>())
const authorizingIds = ref(new Set<string>())
const oauthErrors = ref(new Map<string, string>())

const showJsonImport = ref(false)
const jsonInput = ref('')
const jsonError = ref('')

function parseJsonSafely<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeCapabilityGroup(raw: any): McpCapabilityGroup {
  const items = Array.isArray(raw?.items) ? raw.items : []
  return {
    count: typeof raw?.count === 'number' ? raw.count : items.length,
    items: items.map((item: any) => ({
      name: typeof item?.name === 'string' ? item.name : '',
      description: typeof item?.description === 'string' ? item.description : null,
      uri: typeof item?.uri === 'string' ? item.uri : null,
      mimeType: typeof item?.mimeType === 'string' ? item.mimeType : null,
      inputSchema: item?.inputSchema,
      arguments: item?.arguments,
    })),
  }
}

function normalizeCapabilityDetails(raw: any): McpCapabilityDetails | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    protocolVersion: typeof raw.protocolVersion === 'string' ? raw.protocolVersion : null,
    serverInfo: raw.serverInfo && typeof raw.serverInfo === 'object'
      ? {
          name: typeof raw.serverInfo.name === 'string' ? raw.serverInfo.name : undefined,
          version: typeof raw.serverInfo.version === 'string' ? raw.serverInfo.version : undefined,
        }
      : null,
    capabilities: {
      tools: normalizeCapabilityGroup(raw.capabilities?.tools),
      resources: normalizeCapabilityGroup(raw.capabilities?.resources),
      prompts: normalizeCapabilityGroup(raw.capabilities?.prompts),
    },
  }
}

function buildSummaryFromDetails(details: McpCapabilityDetails | null): McpCapabilitySummary {
  if (!details) return { tools: [], resources: [], prompts: [] }
  return {
    tools: details.capabilities.tools.items.slice(0, 3).map(item => item.name).filter(Boolean),
    resources: details.capabilities.resources.items.slice(0, 3).map(item => item.name || item.uri || '').filter(Boolean),
    prompts: details.capabilities.prompts.items.slice(0, 3).map(item => item.name).filter(Boolean),
  }
}

function normalizeCapabilitySummary(raw: any, details: McpCapabilityDetails | null): McpCapabilitySummary {
  if (!raw || typeof raw !== 'object') return buildSummaryFromDetails(details)
  return {
    tools: Array.isArray(raw.tools) ? raw.tools.filter((item: unknown): item is string => typeof item === 'string') : [],
    resources: Array.isArray(raw.resources) ? raw.resources.filter((item: unknown): item is string => typeof item === 'string') : [],
    prompts: Array.isArray(raw.prompts) ? raw.prompts.filter((item: unknown): item is string => typeof item === 'string') : [],
  }
}

function normalizeServer(raw: RawMcpServer): McpServer {
  const capabilityDetails = normalizeCapabilityDetails(parseJsonSafely(raw.capabilities_json, null))
  const capabilitySummary = normalizeCapabilitySummary(parseJsonSafely(raw.capabilities_summary, null), capabilityDetails)
  const oauthMetadata = parseJsonSafely<McpOAuthMetadata | null>(raw.oauth_metadata_json, null)
  const oauthRegistration = parseJsonSafely<McpOAuthRegistration | null>(raw.oauth_registration_json, null)

  return {
    ...raw,
    last_test_status: raw.last_test_status ?? null,
    last_test_error: raw.last_test_error ?? null,
    last_tested_at: raw.last_tested_at ?? null,
    capabilities_json: raw.capabilities_json ?? null,
    capabilities_summary: raw.capabilities_summary ?? null,
    auth_type: raw.auth_type ?? null,
    oauth_client_id: raw.oauth_client_id ?? null,
    oauth_scope: raw.oauth_scope ?? null,
    oauth_audience: raw.oauth_audience ?? null,
    oauth_token_endpoint_auth_method: raw.oauth_token_endpoint_auth_method ?? null,
    oauth_access_token: raw.oauth_access_token ?? null,
    oauth_refresh_token: raw.oauth_refresh_token ?? null,
    oauth_token_type: raw.oauth_token_type ?? null,
    oauth_expires_at: raw.oauth_expires_at ?? null,
    oauth_id_token: raw.oauth_id_token ?? null,
    oauth_metadata_json: raw.oauth_metadata_json ?? null,
    oauth_registration_json: raw.oauth_registration_json ?? null,
    oauth_auth_state: raw.oauth_auth_state ?? null,
    oauth_redirect_mode: raw.oauth_redirect_mode ?? null,
    oauth_last_error: raw.oauth_last_error ?? null,
    oauth_connected_at: raw.oauth_connected_at ?? null,
    capabilityDetails,
    capabilitySummary,
    oauthMetadata,
    oauthRegistration,
  }
}

function updateTestingState(id: string, active: boolean) {
  const next = new Set(testingIds.value)
  if (active) next.add(id)
  else next.delete(id)
  testingIds.value = next
}

function updateTestResult(id: string, result: McpTestResult | null) {
  const next = new Map(testResults.value)
  if (result) next.set(id, result)
  else next.delete(id)
  testResults.value = next
}

function toggleExpanded(id: string) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function isExpanded(id: string): boolean {
  return expandedIds.value.has(id)
}

function formatDateTime(value: string | null): string {
  if (!value) return '未测试'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function hasSummary(server: McpServer): boolean {
  return capabilitySectionMeta.some(section => server.capabilitySummary[section.key].length > 0)
}

function getSummaryText(server: McpServer, key: CapabilitySectionKey): string {
  return server.capabilitySummary[key].join(', ')
}

function getCapabilityGroup(server: McpServer, key: CapabilitySectionKey): McpCapabilityGroup {
  return server.capabilityDetails?.capabilities[key] ?? { count: 0, items: [] }
}

function stringifyStructuredContent(value: unknown, maxLength = 280): string {
  if (value == null) return ''
  const text = JSON.stringify(value, null, 2)
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function getCapabilityExtra(item: McpCapabilityItem): string {
  if (item.inputSchema) return stringifyStructuredContent(item.inputSchema)
  if (item.arguments) return stringifyStructuredContent(item.arguments)
  return ''
}

function updateAuthorizingState(id: string, active: boolean) {
  const next = new Set(authorizingIds.value)
  if (active) next.add(id)
  else next.delete(id)
  authorizingIds.value = next
}

function updateOAuthError(id: string, message: string | null) {
  const next = new Map(oauthErrors.value)
  if (message) next.set(id, message)
  else next.delete(id)
  oauthErrors.value = next
}

function isOAuthServer(server: McpServer): boolean {
  return server.transport !== 'stdio' && (server.oauth_auth_state !== null || server.oauth_metadata_json !== null || server.oauth_client_id !== null)
}

function isTokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const ms = new Date(expiresAt).getTime()
  if (Number.isNaN(ms)) return false
  return ms <= Date.now()
}

function isOAuthConnected(server: McpServer): boolean {
  return server.oauth_auth_state === 'connected' && Boolean(server.oauth_access_token) && !isTokenExpired(server.oauth_expires_at)
}

function getOAuthStatusLabel(server: McpServer): string {
  if (server.transport === 'stdio') return '本地进程'
  if (authorizingIds.value.has(server.id)) return '授权中'
  if (server.oauth_auth_state === 'unsupported') return '不支持零配置登录'
  if (isOAuthConnected(server)) return '已登录'
  if (server.oauth_auth_state === 'error' || server.oauth_last_error) return '登录失败'
  if (server.oauth_auth_state === 'required') return '需要登录'
  if (server.oauth_access_token && isTokenExpired(server.oauth_expires_at)) return '需要重新登录'
  return '无需登录'
}

function getOAuthStatusClass(server: McpServer): string {
  if (server.transport === 'stdio' || server.oauth_auth_state === 'none' || server.oauth_auth_state === null)
    return 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400'
  if (authorizingIds.value.has(server.id))
    return 'bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10 dark:text-indigo-400'
  if (server.oauth_auth_state === 'unsupported')
    return 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400'
  if (isOAuthConnected(server))
    return 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
  return 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
}

function getOAuthActionLabel(server: McpServer): string {
  if (authorizingIds.value.has(server.id)) return '授权中…'
  return isOAuthConnected(server) ? '重新登录' : '登录'
}

function getOAuthIssuer(server: McpServer): string | null {
  return server.oauthMetadata?.authorizationServer?.issuer ?? null
}

async function openExternalUrl(url: string) {
  if (isTauri()) await open(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function startOAuthLogin(server: McpServer) {
  if (!isOAuthServer(server) || authorizingIds.value.has(server.id) || server.oauth_auth_state === 'unsupported') return

  updateAuthorizingState(server.id, true)
  updateOAuthError(server.id, null)
  try {
    const started = await rpc<McpOAuthStartResult>('mcp.oauthStart', { id: server.id })
    await openExternalUrl(started.authUrl)

    let finished = false
    for (let attempt = 0; attempt < 120; attempt++) {
      await sleep(1000)
      const polled = await rpc<McpOAuthPollResult>('mcp.oauthPoll', { id: server.id, requestId: started.requestId })
      if (polled.status === 'pending') continue

      finished = true
      await loadData()
      if (polled.status === 'success') {
        const updated = servers.value.find(item => item.id === server.id)
        if (updated) await testServer(updated)
      }
      break
    }

    if (!finished) {
      updateOAuthError(server.id, 'OAuth 登录超时，请重试')
    }
  } catch (err) {
    updateOAuthError(server.id, (err as Error)?.message || 'OAuth 登录失败')
    await loadData()
  } finally {
    updateAuthorizingState(server.id, false)
  }
}

async function disconnectOAuth(server: McpServer) {
  if (!isOAuthServer(server)) return
  try {
    updateOAuthError(server.id, null)
    await rpc('mcp.oauthDisconnect', { id: server.id })
    await loadData()
  } catch (err) {
    updateOAuthError(server.id, (err as Error)?.message || '断开 OAuth 授权失败')
  }
}

async function testServer(server: McpServer) {
  updateTestingState(server.id, true)
  updateTestResult(server.id, null)
  try {
    const result = await rpc<McpTestResult>('mcp.test', { id: server.id })
    updateTestResult(server.id, result)
    await loadData()
  } catch (err: any) {
    updateTestResult(server.id, { ok: false, error: err?.message || 'RPC failed' })
  } finally {
    updateTestingState(server.id, false)
  }
}

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

function extractServersFromJson(raw: any): ParsedServer[] {
  const parsedServers: ParsedServer[] = []

  const entries = raw.mcpServers ?? raw.servers ?? raw
  if (typeof entries !== 'object' || entries === null) return []

  if (Array.isArray(entries)) {
    for (const item of entries) {
      if (item.name) parsedServers.push(normalizeServerEntry(item.name, item))
    }
    return parsedServers
  }

  for (const [name, cfg] of Object.entries(entries)) {
    if (typeof cfg === 'object' && cfg !== null) {
      parsedServers.push(normalizeServerEntry(name, cfg as any))
    }
  }
  return parsedServers
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

async function loadData() {
  loading.value = true
  try {
    const result = await rpc<RawMcpServer[]>('mcp.list')
    servers.value = (result ?? []).map(normalizeServer)
  } catch (err) {
    console.error('Failed to load MCP data:', err)
  } finally {
    loading.value = false
  }
}

onMounted(loadData)

function openCreate() {
  editingServer.value = null
  form.value = {
    name: '',
    description: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
  }
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
      payload.url = null
      payload.headers = {}
    } else {
      payload.command = null
      payload.args = []
      payload.env = {}
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
    await rpc<RawMcpServer>('mcp.toggle', { id })
    await loadData()
  } catch (err) {
    console.error('Failed to toggle MCP server:', err)
  }
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
        <div class="flex items-start gap-3">
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

            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                :class="getOAuthStatusClass(server)"
              >
                <div
                  class="w-1.5 h-1.5 rounded-full"
                  :class="isOAuthConnected(server)
                    ? 'bg-emerald-500'
                    : authorizingIds.has(server.id)
                      ? 'bg-indigo-500'
                      : 'bg-amber-500'"
                />
                {{ getOAuthStatusLabel(server) }}
              </span>
              <span
                v-if="isOAuthServer(server) && server.oauth_expires_at"
                class="text-[10px] text-gray-400 tabular-nums"
              >
                过期 {{ formatDateTime(server.oauth_expires_at) }}
              </span>
              <span
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                :class="server.last_test_status === 'success'
                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : server.last_test_status === 'error'
                    ? 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400'
                    : 'bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400'"
              >
                <div
                  class="w-1.5 h-1.5 rounded-full"
                  :class="server.last_test_status === 'success'
                    ? 'bg-emerald-500'
                    : server.last_test_status === 'error'
                      ? 'bg-red-500'
                      : 'bg-gray-400'"
                />
                {{
                  server.last_test_status === 'success'
                    ? '最近探测成功'
                    : server.last_test_status === 'error'
                      ? '最近探测失败'
                      : '尚未探测'
                }}
              </span>
              <span class="text-[10px] text-gray-400 tabular-nums">
                {{ formatDateTime(server.last_tested_at) }}
              </span>
              <span
                v-for="section in capabilitySectionMeta"
                :key="section.key"
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400"
              >
                <span>{{ section.label }}</span>
                <span class="tabular-nums">{{ getCapabilityGroup(server, section.key).count }}</span>
              </span>
            </div>

            <div
              v-if="isOAuthServer(server) && server.oauth_auth_state !== 'none'"
              class="mt-2 flex flex-wrap items-center gap-2"
            >
              <button
                v-if="server.oauth_auth_state !== 'unsupported'"
                class="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-indigo-500 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/15 transition-colors disabled:opacity-50"
                :disabled="authorizingIds.has(server.id)"
                @click="startOAuthLogin(server)"
              >
                <div
                  v-if="authorizingIds.has(server.id)"
                  class="w-3 h-3 border-2 border-indigo-300 border-t-indigo-500 rounded-full animate-spin"
                />
                <div v-else class="i-carbon-login w-3 h-3" />
                {{ getOAuthActionLabel(server) }}
              </button>
              <button
                v-if="server.oauth_access_token || server.oauth_last_error || isOAuthConnected(server)"
                class="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 transition-colors"
                @click="disconnectOAuth(server)"
              >
                <div class="i-carbon-logout w-3 h-3" />
                断开授权
              </button>
            </div>

            <p
              v-if="oauthErrors.has(server.id)"
              class="mt-1 text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all"
            >
              {{ oauthErrors.get(server.id) }}
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

            <div v-if="hasSummary(server)" class="mt-2 space-y-1">
              <template
                v-for="section in capabilitySectionMeta"
                :key="`summary-${server.id}-${section.key}`"
              >
                <div
                  v-if="server.capabilitySummary[section.key].length > 0"
                  class="flex items-start gap-2 text-[11px]"
                >
                  <span class="text-gray-400 shrink-0 w-16">
                    {{ section.label }}
                  </span>
                  <span class="text-gray-600 dark:text-gray-300 min-w-0 truncate">
                    {{ getSummaryText(server, section.key) }}
                  </span>
                </div>
              </template>
            </div>
            <p
              v-else-if="server.last_test_status === 'success'"
              class="mt-2 text-[11px] text-gray-400"
            >
              已连接，但未发现可枚举的 tools/resources/prompts 能力。
            </p>

            <p
              v-if="server.last_test_status === 'error' && server.last_test_error"
              class="mt-2 text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all"
            >
              {{ server.last_test_error }}
            </p>

            <button
              v-if="server.capabilityDetails || server.last_test_error || isOAuthServer(server)"
              class="mt-2 inline-flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-600 transition-colors"
              @click="toggleExpanded(server.id)"
            >
              <div
                class="i-carbon-chevron-down w-3 h-3 transition-transform duration-150"
                :class="isExpanded(server.id) ? 'rotate-180' : ''"
              />
              {{ isExpanded(server.id) ? '收起明细' : '展开明细' }}
            </button>

            <div
              v-if="isExpanded(server.id)"
              class="mt-3 rounded-xl border border-gray-200 dark:border-white/8 bg-gray-50/80 dark:bg-white/3 px-3 py-3 space-y-3"
            >
              <div class="flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
                <span v-if="server.capabilityDetails?.serverInfo?.name">
                  Server: {{ server.capabilityDetails.serverInfo.name }}
                </span>
                <span v-if="server.capabilityDetails?.serverInfo?.version">
                  Version: {{ server.capabilityDetails.serverInfo.version }}
                </span>
                <span v-if="server.capabilityDetails?.protocolVersion">
                  Protocol: {{ server.capabilityDetails.protocolVersion }}
                </span>
              </div>

              <div
                v-if="isOAuthServer(server)"
                class="rounded-lg border border-gray-200/70 dark:border-white/6 bg-white dark:bg-[#2f2f34] px-3 py-2 space-y-1.5"
              >
                <div class="flex items-center justify-between">
                  <h3 class="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                    OAuth
                  </h3>
                  <span class="text-[10px]" :class="getOAuthStatusClass(server)">
                    {{ getOAuthStatusLabel(server) }}
                  </span>
                </div>
                <p class="text-[11px] text-gray-500 dark:text-gray-300">
                  Client ID: <span class="font-mono break-all">{{ server.oauthRegistration?.client_id || server.oauth_client_id || '未注册' }}</span>
                </p>
                <p v-if="server.oauth_redirect_mode" class="text-[11px] text-gray-500 dark:text-gray-300">
                  回调模式: <span class="break-all">{{ server.oauth_redirect_mode === 'deeplink' ? 'Deep Link' : 'Loopback' }}</span>
                </p>
                <p v-if="getOAuthIssuer(server)" class="text-[11px] text-gray-500 dark:text-gray-300">
                  Issuer: <span class="break-all">{{ getOAuthIssuer(server) }}</span>
                </p>
                <p v-if="server.oauth_connected_at" class="text-[11px] text-gray-500 dark:text-gray-300">
                  最近授权: {{ formatDateTime(server.oauth_connected_at) }}
                </p>
                <p v-if="server.oauth_expires_at" class="text-[11px] text-gray-500 dark:text-gray-300">
                  Token 过期: {{ formatDateTime(server.oauth_expires_at) }}
                </p>
                <p
                  v-if="server.oauth_last_error"
                  class="text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all"
                >
                  {{ server.oauth_last_error }}
                </p>
              </div>

              <div
                v-if="server.last_test_status === 'error' && server.last_test_error"
                class="rounded-lg border border-red-200/70 dark:border-red-500/20 bg-red-50/80 dark:bg-red-500/5 px-3 py-2"
              >
                <p class="text-[11px] font-medium text-red-500 dark:text-red-400">最近一次探测失败</p>
                <p class="mt-1 text-[11px] text-red-500 dark:text-red-400 leading-relaxed break-all">
                  {{ server.last_test_error }}
                </p>
              </div>

              <div
                v-for="section in capabilitySectionMeta"
                :key="`detail-${server.id}-${section.key}`"
                class="space-y-1.5"
              >
                <div class="flex items-center justify-between">
                  <h3 class="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                    {{ section.label }}
                  </h3>
                  <span class="text-[10px] text-gray-400 tabular-nums">
                    {{ getCapabilityGroup(server, section.key).count }}
                  </span>
                </div>

                <div
                  v-if="getCapabilityGroup(server, section.key).items.length > 0"
                  class="space-y-2"
                >
                  <div
                    v-for="item in getCapabilityGroup(server, section.key).items"
                    :key="item.uri || item.name"
                    class="rounded-lg bg-white dark:bg-[#2f2f34] border border-gray-200/70 dark:border-white/6 px-3 py-2"
                  >
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <p class="text-[12px] font-medium text-gray-700 dark:text-gray-100 break-all">
                          {{ item.name || item.uri }}
                        </p>
                        <p
                          v-if="item.uri && item.uri !== item.name"
                          class="mt-0.5 text-[10px] text-gray-400 font-mono break-all"
                        >
                          {{ item.uri }}
                        </p>
                      </div>
                      <span
                        v-if="item.mimeType"
                        class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400 shrink-0"
                      >
                        {{ item.mimeType }}
                      </span>
                    </div>
                    <p
                      v-if="item.description"
                      class="mt-1 text-[11px] text-gray-500 dark:text-gray-300 leading-relaxed"
                    >
                      {{ item.description }}
                    </p>
                    <pre
                      v-if="getCapabilityExtra(item)"
                      class="mt-2 text-[10px] text-gray-500 dark:text-gray-300 font-mono whitespace-pre-wrap break-all rounded-lg bg-gray-50 dark:bg-black/20 px-2.5 py-2 overflow-hidden"
                    >{{ getCapabilityExtra(item) }}</pre>
                  </div>
                </div>

                <p
                  v-else
                  class="text-[11px] text-gray-400"
                >
                  未提供此类能力。
                </p>
              </div>
            </div>
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
              <p class="text-[11px] text-gray-400 leading-relaxed">
                OAuth 登录已改为零配置模式。若服务器支持 DCR，会在测试或登录时自动识别并完成注册；若不支持，会在卡片上直接显示“不支持零配置登录”。
              </p>
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
