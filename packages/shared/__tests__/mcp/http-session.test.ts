import { describe, expect, it, vi } from 'vitest'
import { McpHttpSession } from '../../src/mcp/http-session'

function makeFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init)
}

function jsonRes(body: unknown, init?: ResponseInit & { sessionId?: string }): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (init?.sessionId) headers.set('mcp-session-id', init.sessionId)
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers })
}

describe('McpHttpSession', () => {
  it('initialize → 透传 Mcp-Session-Id 到后续请求', async () => {
    const calls: { method: string, headers: Record<string, string> }[] = []

    const fetchFn = makeFetch(async (_url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries())
      const body = JSON.parse(String(init?.body ?? '{}'))
      calls.push({ method: body.method, headers })
      if (body.method === 'initialize') {
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake' } } }, { sessionId: 'sess-1' })
      }
      if (body.method === 'notifications/initialized') return new Response('{}', { status: 202 })
      if (body.method === 'tools/list') {
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'foo' }] } })
      }
      return new Response('not handled', { status: 500 })
    })

    const session = new McpHttpSession({ url: 'https://mcp.example/api', fetchFn })
    await session.initialize()
    const tools = await session.call('tools/list', {})

    expect(session.getSessionId()).toBe('sess-1')
    expect((tools as any).tools[0].name).toBe('foo')
    const toolsCall = calls.find(c => c.method === 'tools/list')!
    expect(toolsCall.headers['mcp-session-id']).toBe('sess-1')
  })

  it('initialize 失败时抛错', async () => {
    const fetchFn = makeFetch(async () => jsonRes({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'init rejected' } }))
    const session = new McpHttpSession({ url: 'https://mcp.example/api', fetchFn })
    await expect(session.initialize()).rejects.toThrow('init rejected')
  })

  it('call 收到非 2xx 时走 onHttpError 钩子', async () => {
    const fetchFn = makeFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.method === 'initialize') return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} })
      if (body.method === 'notifications/initialized') return new Response('{}', { status: 202 })
      return new Response('forbidden', { status: 403 })
    })

    const onHttpError = vi.fn(async (res: Response) => new Error(`custom: ${res.status}`))
    const session = new McpHttpSession({ url: 'https://mcp.example/api', fetchFn, onHttpError })
    await session.initialize()
    await expect(session.call('tools/list', {})).rejects.toThrow('custom: 403')
    expect(onHttpError).toHaveBeenCalled()
  })

  it('initialize 是幂等的（多次调用只发一次）', async () => {
    let initCount = 0
    const fetchFn = makeFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.method === 'initialize') {
        initCount++
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} }, { sessionId: 's' })
      }
      return new Response('{}', { status: 202 })
    })
    const session = new McpHttpSession({ url: 'https://mcp.example/api', fetchFn })
    await session.initialize()
    await session.initialize()
    expect(initCount).toBe(1)
  })
})
