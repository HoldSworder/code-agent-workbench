import { parseMcpResponseText, type JsonRpcResponse } from './parse'

export interface McpHttpSessionOptions {
  url: string
  /** 自定义 header（例如 Authorization）。 */
  headers?: Record<string, string>
  initializeTimeoutMs?: number
  callTimeoutMs?: number
  notifyTimeoutMs?: number
  /** 客户端信息（默认 `code-agent`）。 */
  clientInfo?: { name: string, version: string }
  /** 自定义 fetch 实现，便于测试注入。 */
  fetchFn?: typeof fetch
  /**
   * 收到非 2xx 响应时调用。返回 Error 或抛出由本钩子提供的 error，
   * 否则返回 undefined 表示走默认 `HTTP <status>` 错误。
   */
  onHttpError?: (response: Response, info: { method: string }) => Promise<Error | undefined> | Error | undefined
}

const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

/**
 * 复用同一 base header 与 Mcp-Session-Id 的 MCP HTTP 会话。
 *
 * 适用于 streamable-http MCP server（飞书项目 / 一般 HTTP MCP）。
 * stdio 服务器请用 `probe.ts` 的 stdio 路径，本类不处理。
 */
export class McpHttpSession {
  private url: string
  private headers: Record<string, string>
  private sessionId: string | null = null
  private nextId = 1
  private initialized = false
  private opts: McpHttpSessionOptions
  private fetchFn: typeof fetch

  constructor(opts: McpHttpSessionOptions) {
    if (!opts.url) throw new Error('McpHttpSession 缺少 url')
    this.url = opts.url
    this.opts = opts
    this.fetchFn = opts.fetchFn ?? fetch
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(opts.headers ?? {}),
    }
  }

  /** 当前服务器返回的 Mcp-Session-Id，可能为 null。 */
  getSessionId(): string | null {
    return this.sessionId
  }

  /**
   * 发起 initialize 请求（带 protocolVersion 协商），并发出 notifications/initialized。
   * 同一会话只会真正执行一次。
   */
  async initialize(): Promise<JsonRpcResponse> {
    if (this.initialized) return { result: {} }
    const clientInfo = this.opts.clientInfo ?? { name: 'code-agent', version: '0.1.0' }
    const initRes = await this.send('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    }, this.opts.initializeTimeoutMs ?? 15_000)
    if (initRes.error) throw new Error(`MCP initialize 失败: ${initRes.error.message ?? 'unknown'}`)

    await this.notify('notifications/initialized')
    this.initialized = true
    return initRes
  }

  /** 发送一个有 id 的 JSON-RPC 请求，自动解析响应。 */
  async call(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse['result']> {
    const res = await this.send(method, params, this.opts.callTimeoutMs ?? 30_000)
    if (res.error) throw new Error(`MCP ${method} 失败: ${res.error.message ?? 'unknown'}`)
    return res.result
  }

  /** 发送一个无 id 的 JSON-RPC notification。失败被静默吞掉。 */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    try {
      await this.fetchFn(this.url, {
        method: 'POST',
        headers: this.requestHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          ...(params ? { params } : {}),
        }),
        signal: AbortSignal.timeout(this.opts.notifyTimeoutMs ?? 8_000),
      })
    }
    catch { /* notification 失败不影响主流程 */ }
  }

  /**
   * 底层请求实现。会更新 Mcp-Session-Id（initialize 后第一次响应携带）。
   * 调用方可通过 `onHttpError` 钩子在收到非 2xx 时定制错误。
   */
  private async send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonRpcResponse> {
    const headers = this.requestHeaders()
    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      if (this.opts.onHttpError) {
        const err = await this.opts.onHttpError(response, { method })
        if (err) throw err
      }
      const body = await response.text().catch(() => '')
      throw new Error(`MCP ${method} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }

    const sid = response.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    const body = await response.text()
    return parseMcpResponseText(body)
  }

  private requestHeaders(): Record<string, string> {
    if (!this.sessionId) return this.headers
    return { ...this.headers, 'Mcp-Session-Id': this.sessionId }
  }
}
