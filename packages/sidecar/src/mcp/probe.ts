import { spawn as spawnChild } from 'node:child_process'
import { parseMcpResponseText as sharedParseMcpResponseText } from '@code-agent/shared/mcp'
import type { JsonRpcResponse as SharedJsonRpcResponse } from '@code-agent/shared/mcp'
import type { McpOAuthMetadataBundle, OAuthTokenSet, RefreshTokenInput } from './oauth'
import { detectOAuthRequirement, resolveOAuthAccessToken } from './oauth'

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpProbeTarget {
  transport: McpTransport
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  oauth?: {
    clientId?: string | null
    accessToken?: string | null
    refreshToken?: string | null
    expiresAt?: string | null
    audience?: string | null
    metadata?: McpOAuthMetadataBundle | null
    refreshAccessToken?: (input: RefreshTokenInput) => Promise<OAuthTokenSet>
    onRefresh?: (tokens: OAuthTokenSet) => Promise<void> | void
  }
}

export interface McpCapabilityItem {
  name: string
  description?: string | null
  uri?: string | null
  mimeType?: string | null
  inputSchema?: unknown
  arguments?: unknown
}

export interface McpCapabilityGroup {
  count: number
  items: McpCapabilityItem[]
}

export interface McpCapabilitiesSnapshot {
  tools: McpCapabilityGroup
  resources: McpCapabilityGroup
  prompts: McpCapabilityGroup
}

export interface McpCapabilitySummary {
  tools: string[]
  resources: string[]
  prompts: string[]
}

export interface McpProbeResult {
  ok: boolean
  error?: string
  protocolVersion?: string | null
  serverInfo?: {
    name?: string
    version?: string
  }
  capabilities: McpCapabilitiesSnapshot
  summary: McpCapabilitySummary
  auth?: {
    state: 'none' | 'required' | 'connected' | 'unsupported' | 'error'
    metadata?: McpOAuthMetadataBundle | null
  }
}

type JsonRpcResponse = SharedJsonRpcResponse

const EMPTY_GROUP: McpCapabilityGroup = { count: 0, items: [] }
const EMPTY_CAPABILITIES: McpCapabilitiesSnapshot = {
  tools: EMPTY_GROUP,
  resources: EMPTY_GROUP,
  prompts: EMPTY_GROUP,
}
const EMPTY_SUMMARY: McpCapabilitySummary = {
  tools: [],
  resources: [],
  prompts: [],
}

function emptyResult(error?: string, auth?: McpProbeResult['auth']): McpProbeResult {
  return {
    ok: false,
    error,
    capabilities: {
      tools: { ...EMPTY_GROUP, items: [] },
      resources: { ...EMPTY_GROUP, items: [] },
      prompts: { ...EMPTY_GROUP, items: [] },
    },
    summary: { ...EMPTY_SUMMARY, tools: [], resources: [], prompts: [] },
    auth,
  }
}

function normalizeToolItems(result: any): McpCapabilityGroup {
  const tools = Array.isArray(result?.tools) ? result.tools : []
  return {
    count: tools.length,
    items: tools.map((tool: any) => ({
      name: typeof tool?.name === 'string' ? tool.name : '',
      description: typeof tool?.description === 'string' ? tool.description : null,
      inputSchema: tool?.inputSchema,
    })),
  }
}

function normalizeResourceItems(result: any): McpCapabilityGroup {
  const resources = Array.isArray(result?.resources) ? result.resources : []
  return {
    count: resources.length,
    items: resources.map((resource: any) => ({
      name: typeof resource?.name === 'string'
        ? resource.name
        : (typeof resource?.uri === 'string' ? resource.uri : ''),
      description: typeof resource?.description === 'string' ? resource.description : null,
      uri: typeof resource?.uri === 'string' ? resource.uri : null,
      mimeType: typeof resource?.mimeType === 'string' ? resource.mimeType : null,
    })),
  }
}

function normalizePromptItems(result: any): McpCapabilityGroup {
  const prompts = Array.isArray(result?.prompts) ? result.prompts : []
  return {
    count: prompts.length,
    items: prompts.map((prompt: any) => ({
      name: typeof prompt?.name === 'string' ? prompt.name : '',
      description: typeof prompt?.description === 'string' ? prompt.description : null,
      arguments: prompt?.arguments,
    })),
  }
}

export function buildCapabilitySummary(capabilities: McpCapabilitiesSnapshot, limit = 3): McpCapabilitySummary {
  return {
    tools: capabilities.tools.items.slice(0, limit).map(item => item.name).filter(Boolean),
    resources: capabilities.resources.items.slice(0, limit).map(item => item.name || item.uri || '').filter(Boolean),
    prompts: capabilities.prompts.items.slice(0, limit).map(item => item.name).filter(Boolean),
  }
}

/** Re-export shared parser for backward compatibility within the package. */
export const parseMcpResponseText = sharedParseMcpResponseText

async function readJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text()
  return parseMcpResponseText(text)
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function createProbeResult(
  init: JsonRpcResponse,
  tools: JsonRpcResponse,
  resources: JsonRpcResponse,
  prompts: JsonRpcResponse,
  auth?: McpProbeResult['auth'],
): McpProbeResult {
  const capabilities: McpCapabilitiesSnapshot = {
    tools: normalizeToolItems(tools.result),
    resources: normalizeResourceItems(resources.result),
    prompts: normalizePromptItems(prompts.result),
  }

  return {
    ok: true,
    protocolVersion: init.result?.protocolVersion ?? null,
    serverInfo: init.result?.serverInfo,
    capabilities,
    summary: buildCapabilitySummary(capabilities),
    auth,
  }
}

function methodNotSupported(response: JsonRpcResponse): boolean {
  return response.error?.code === -32601
}

async function runOptionalRequest(request: () => Promise<JsonRpcResponse>): Promise<JsonRpcResponse> {
  try {
    const response = await request()
    if (methodNotSupported(response)) return { result: {} }
    if (response.error) throw new Error(response.error.message || 'MCP request failed')
    return response
  }
  catch (error) {
    const message = toErrorMessage(error, 'MCP request failed')
    if (message.includes('Method not found')) return { result: {} }
    throw error
  }
}

async function probeHttpLikeServer(target: McpProbeTarget): Promise<McpProbeResult> {
  const url = target.url
  if (!url) return emptyResult('No URL configured')

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(target.headers ?? {}),
  }

  if (target.oauth) {
    if (!target.oauth.refreshAccessToken) return emptyResult('OAuth support is not configured for this MCP server')
    try {
      const { accessToken, refreshedTokens } = await resolveOAuthAccessToken({
        mcpUrl: url,
        clientId: target.oauth.clientId ?? null,
        accessToken: target.oauth.accessToken ?? null,
        refreshToken: target.oauth.refreshToken ?? null,
        expiresAt: target.oauth.expiresAt ?? null,
        audience: target.oauth.audience ?? null,
        metadata: target.oauth.metadata ?? null,
      }, target.oauth.refreshAccessToken)

      baseHeaders.Authorization = `Bearer ${accessToken}`
      if (refreshedTokens)
        await target.oauth.onRefresh?.(refreshedTokens)
    }
    catch (error) {
      return emptyResult(toErrorMessage(error, 'OAuth login required'), {
        state: 'required',
        metadata: target.oauth.metadata ?? null,
      })
    }
  }
  let nextId = 1

  const sendRequest = async (method: string, params?: Record<string, unknown>): Promise<{ response: JsonRpcResponse, sessionId: string | null }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        ...(params ? { params } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      if (response.status === 401 && !target.oauth) {
        const requirement = await detectOAuthRequirement(url)
        if (requirement) {
          const error = new Error(requirement.error) as Error & { oauthRequirement?: Awaited<ReturnType<typeof detectOAuthRequirement>> }
          error.oauthRequirement = requirement
          throw error
        }
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return {
      response: await readJsonRpcResponse(response),
      sessionId: response.headers.get('mcp-session-id'),
    }
  }

  let init: { response: JsonRpcResponse, sessionId: string | null }
  try {
    init = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'code-agent-test', version: '0.1.0' },
    })
  }
  catch (error) {
    const requirement = (error as Error & { oauthRequirement?: Awaited<ReturnType<typeof detectOAuthRequirement>> }).oauthRequirement
    if (requirement) {
      return emptyResult(requirement.error, {
        state: requirement.authState,
        metadata: requirement.metadata,
      })
    }
    throw error
  }
  if (init.response.error) return emptyResult(init.response.error.message || 'MCP init rejected')

  const requestHeaders = init.sessionId
    ? { ...baseHeaders, 'Mcp-Session-Id': init.sessionId }
    : baseHeaders

  await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)

  const sendFollowup = async (method: string) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: {},
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return readJsonRpcResponse(response)
  }

  const tools = await runOptionalRequest(() => sendFollowup('tools/list'))
  const resources = await runOptionalRequest(() => sendFollowup('resources/list'))
  const prompts = await runOptionalRequest(() => sendFollowup('prompts/list'))

  return createProbeResult(init.response, tools, resources, prompts, {
    state: target.oauth ? 'connected' : 'none',
    metadata: target.oauth?.metadata ?? null,
  })
}

class StdioProbeSession {
  private readonly child
  private readonly pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private buffer = ''
  private nextId = 1
  private closed = false

  constructor(command: string, args: string[], envVars: Record<string, string>) {
    this.child = spawnChild(command, args, {
      env: { ...process.env, ...envVars },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.flushBuffer()
    })

    this.child.on('error', (error) => {
      this.failAll(error)
    })

    this.child.on('close', () => {
      this.failAll(new Error('MCP stdio process closed before response was received'))
    })
  }

  private flushBuffer(): void {
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      try {
        const message = JSON.parse(line) as JsonRpcResponse
        if (typeof message.id !== 'number') continue
        const pending = this.pending.get(message.id)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        pending.resolve(message)
      }
      catch {
        continue
      }
    }
  }

  private failAll(reason: unknown): void {
    if (this.closed) return
    this.closed = true
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
      this.pending.delete(id)
    }
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<JsonRpcResponse> {
    if (!this.child.stdin) throw new Error('MCP stdio stdin is unavailable')
    const id = this.nextId++
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    })

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method} response`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin!.write(`${payload}\n`)
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child.stdin) return
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    })
    this.child.stdin.write(`${payload}\n`)
  }

  close(): void {
    this.failAll(new Error('MCP stdio session closed'))
    this.child.kill()
  }
}

async function probeStdioServer(target: McpProbeTarget): Promise<McpProbeResult> {
  if (!target.command) return emptyResult('No command configured')

  const session = new StdioProbeSession(target.command, target.args ?? [], target.env ?? {})
  try {
    const init = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'code-agent-test', version: '0.1.0' },
    })
    if (init.error) return emptyResult(init.error.message || 'MCP init rejected')

    session.notify('notifications/initialized')

    const tools = await runOptionalRequest(() => session.request('tools/list', {}))
    const resources = await runOptionalRequest(() => session.request('resources/list', {}))
    const prompts = await runOptionalRequest(() => session.request('prompts/list', {}))

    return createProbeResult(init, tools, resources, prompts)
  }
  catch (error) {
    return emptyResult(toErrorMessage(error, 'Connection failed'))
  }
  finally {
    session.close()
  }
}

export async function probeMcpServer(target: McpProbeTarget): Promise<McpProbeResult> {
  try {
    if (target.transport === 'stdio') return await probeStdioServer(target)
    return await probeHttpLikeServer(target)
  }
  catch (error) {
    return emptyResult(toErrorMessage(error, 'Connection failed'))
  }
}
