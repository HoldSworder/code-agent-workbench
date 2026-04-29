import { errorMessage } from '@code-agent/shared/util'
import { McpHttpSession } from '@code-agent/shared/mcp'
import type { McpServerRepository, McpServer } from '../db/repositories/mcp-server.repo'

export interface FeishuMcpStatus {
  configured: boolean
  healthy: boolean
  mcpId: string | null
  mcpName: string | null
  toolCount: number | null
  lastError: string | null
}

/**
 * 根据 DB 中存储的 MCP 配置，构造一个已 initialize 的 McpHttpSession。
 * 飞书项目 MCP 仅支持 streamable HTTP transport。
 */
async function openSession(server: McpServer): Promise<McpHttpSession> {
  if (server.transport !== 'http') throw new Error('飞书项目 MCP 必须是 streamable HTTP 类型')
  if (!server.url) throw new Error('飞书项目 MCP 缺少 URL')

  let extraHeaders: Record<string, string> = {}
  try { extraHeaders = JSON.parse(server.headers) }
  catch { extraHeaders = {} }

  const headers: Record<string, string> = { ...extraHeaders }
  if (server.oauth_access_token) {
    headers.Authorization = `${server.oauth_token_type ?? 'Bearer'} ${server.oauth_access_token}`
  }

  const session = new McpHttpSession({
    url: server.url,
    headers,
    initializeTimeoutMs: 15_000,
    callTimeoutMs: 30_000,
    notifyTimeoutMs: 8_000,
    clientInfo: { name: 'code-agent-sidecar', version: '0.1.0' },
  })
  await session.initialize()
  return session
}

export class FeishuProjectMcpClient {
  constructor(private repo: McpServerRepository) {}

  getServer(): McpServer | null {
    return this.repo.findFeishuProject()
  }

  async checkStatus(): Promise<FeishuMcpStatus> {
    const server = this.getServer()
    if (!server) {
      return { configured: false, healthy: false, mcpId: null, mcpName: null, toolCount: null, lastError: '尚未在 MCP 页面标记任何 MCP 为飞书项目 MCP' }
    }
    if (!server.enabled) {
      return { configured: true, healthy: false, mcpId: server.id, mcpName: server.name, toolCount: null, lastError: '该 MCP 已被禁用' }
    }
    try {
      const session = await openSession(server)
      const tools = await session.call('tools/list', {})
      const list = Array.isArray((tools as any)?.tools) ? (tools as any).tools : []
      return { configured: true, healthy: true, mcpId: server.id, mcpName: server.name, toolCount: list.length, lastError: null }
    }
    catch (err) {
      return { configured: true, healthy: false, mcpId: server.id, mcpName: server.name, toolCount: null, lastError: errorMessage(err) }
    }
  }

  /**
   * 透传 tools/call。要求事先已通过 setFeishuProject 标记。
   */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const server = this.getServer()
    if (!server) throw new Error('未配置飞书项目 MCP')
    if (!server.enabled) throw new Error('飞书项目 MCP 已被禁用')

    const session = await openSession(server)
    const result = await session.call('tools/call', { name, arguments: args })
    return result as T
  }

  /**
   * 列出当前飞书项目 MCP 暴露的所有工具名。
   * 不同部署/版本可能用不同前缀（例如 `get_view_detail` vs `lark-project-dx-get_view_detail`），
   * 调用方据此做关键字匹配的兼容查找。
   */
  async listToolNames(): Promise<string[]> {
    const server = this.getServer()
    if (!server) throw new Error('未配置飞书项目 MCP')
    if (!server.enabled) throw new Error('飞书项目 MCP 已被禁用')
    const session = await openSession(server)
    const tools = await session.call('tools/list', {})
    const list = Array.isArray((tools as any)?.tools) ? (tools as any).tools : []
    return list
      .map((t: { name?: unknown }) => (typeof t?.name === 'string' ? t.name : ''))
      .filter((n: string) => n.length > 0)
  }
}
