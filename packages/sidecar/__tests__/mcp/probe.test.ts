import { describe, expect, it, vi } from 'vitest'
import { probeMcpServer } from '../../src/mcp/probe'
import type { McpOAuthMetadataBundle } from '../../src/mcp/oauth'

const STDIO_MCP_SERVER = `
let buffer = '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const msg = JSON.parse(line);

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'stdio-probe', version: '1.0.0' },
          capabilities: { tools: {}, resources: {}, prompts: {} },
        },
      });
      continue;
    }

    if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'project.search', description: 'Search projects' },
          ],
        },
      });
      continue;
    }

    if (msg.method === 'resources/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          resources: [
            { uri: 'wiki://space/doc', name: 'Doc', description: 'Wiki document' },
          ],
        },
      });
      continue;
    }

    if (msg.method === 'prompts/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          prompts: [
            { name: 'summarize', description: 'Summarize document' },
          ],
        },
      });
    }
  }
});
`

describe('probeMcpServer', () => {
  it('discovers capabilities from stdio MCP servers', async () => {
    const result = await probeMcpServer({
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', STDIO_MCP_SERVER],
    })

    expect(result.ok).toBe(true)
    expect(result.serverInfo?.name).toBe('stdio-probe')
    expect(result.capabilities.tools.count).toBe(1)
    expect(result.capabilities.resources.count).toBe(1)
    expect(result.capabilities.prompts.count).toBe(1)
    expect(result.summary.tools).toEqual(['project.search'])
  })

  it('adds bearer token to HTTP MCP probes', async () => {
    const calls: string[] = []
    const metadata: McpOAuthMetadataBundle = {
      resource: {
        resource: 'https://mcp.example.com/team/mcp',
        authorization_servers: ['https://auth.example.com'],
      },
      authorizationServer: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(String(init?.headers ? (init.headers as Record<string, string>).Authorization : ''))
      if (url === 'https://mcp.example.com/team/mcp') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        if (body.method === 'initialize') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'oauth-http', version: '1.0.0' },
              capabilities: { tools: {}, resources: {}, prompts: {} },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'session-1' } })
        }
        if (body.method === 'notifications/initialized')
          return new Response('', { status: 202 })
        if (body.method === 'tools/list')
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'project.search' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (body.method === 'resources/list')
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resources: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (body.method === 'prompts/list')
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { prompts: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await probeMcpServer({
      transport: 'http',
      url: 'https://mcp.example.com/team/mcp',
      oauth: {
        clientId: 'desktop-client',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: null,
        metadata,
        refreshAccessToken: vi.fn(),
      },
    })

    expect(result.ok).toBe(true)
    expect(calls.every(header => header === 'Bearer access-token' || header === '')).toBe(true)
    expect(calls.filter(header => header === 'Bearer access-token').length).toBeGreaterThan(0)
  })

  it('refreshes an expired oauth token before probing HTTP MCP servers', async () => {
    const refreshSpy = vi.fn().mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenType: 'Bearer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      idToken: null,
    })
    const onRefresh = vi.fn()
    const authHeaders: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      authHeaders.push(String(init?.headers ? (init.headers as Record<string, string>).Authorization : ''))
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (url === 'https://mcp.example.com/team/mcp' && body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'oauth-http', version: '1.0.0' },
            capabilities: { tools: {}, resources: {}, prompts: {} },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'session-1' } })
      }
      if (url === 'https://mcp.example.com/team/mcp' && body.method === 'notifications/initialized')
        return new Response('', { status: 202 })
      if (url === 'https://mcp.example.com/team/mcp' && body.method === 'tools/list')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === 'https://mcp.example.com/team/mcp' && body.method === 'resources/list')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resources: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === 'https://mcp.example.com/team/mcp' && body.method === 'prompts/list')
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { prompts: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await probeMcpServer({
      transport: 'http',
      url: 'https://mcp.example.com/team/mcp',
      oauth: {
        clientId: 'desktop-client',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        expiresAt: '2000-01-01T00:00:00.000Z',
        metadata: {
          resource: {
            resource: 'https://mcp.example.com/team/mcp',
            authorization_servers: ['https://auth.example.com'],
          },
          authorizationServer: {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          },
        },
        refreshAccessToken: refreshSpy,
        onRefresh,
      },
    })

    expect(result.ok).toBe(true)
    expect(refreshSpy).toHaveBeenCalledOnce()
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(authHeaders.filter(header => header === 'Bearer new-access-token').length).toBeGreaterThan(0)
  })
})
