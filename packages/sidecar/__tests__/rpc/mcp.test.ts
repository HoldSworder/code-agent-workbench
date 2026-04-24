import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'node:http'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { RpcServer } from '../../src/rpc/server'
import { registerMethods } from '../../src/rpc/methods'
import { WorkflowEngine } from '../../src/workflow/engine'
import { McpServerRepository } from '../../src/db/repositories/mcp-server.repo'
import type { AgentProvider } from '../../src/providers/types'

const WORKFLOW_YAML = `
name: test
description: test workflow
stages:
  - id: planning
    name: 规划
    phases:
      - id: design
        name: 设计
        requires_confirm: false
        provider: api
        skill: skills/design.md
`

function buildSsePayload(body: unknown): string {
  return `event: message\ndata: ${JSON.stringify(body)}\n\n`
}

function readResponse(url: string): Promise<{ statusCode: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk.toString() })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body,
        })
      })
    })
    req.on('error', reject)
  })
}

function mockSuccessfulSseProbe() {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  fetchMock
    .mockResolvedValueOnce(new Response(buildSsePayload({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'feishu-project', version: '1.0.0' },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'mcp-session-id': 'session-1',
      },
    }))
    .mockResolvedValueOnce(new Response('', { status: 202 }))
    .mockResolvedValueOnce(new Response(buildSsePayload({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'project.search', description: 'Search project items' },
          { name: 'project.update', description: 'Update project item' },
        ],
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    .mockResolvedValueOnce(new Response(buildSsePayload({
      jsonrpc: '2.0',
      id: 3,
      result: {
        resources: [
          { uri: 'wiki://space/doc', name: 'Doc', description: 'Wiki doc' },
        ],
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    .mockResolvedValueOnce(new Response(buildSsePayload({
      jsonrpc: '2.0',
      id: 4,
      result: {
        prompts: [
          { name: 'summarize', description: 'Summarize wiki doc' },
        ],
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))

  return fetchMock
}

describe('mcp.test RPC', () => {
  let db: Database.Database
  let server: RpcServer
  let repo: McpServerRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    repo = new McpServerRepository(db)

    const engine = new WorkflowEngine({
      db,
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: (): AgentProvider => ({
        run: vi.fn().mockResolvedValue({ status: 'success', output: '' }),
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
      resolveSkillContent: () => '',
    })

    server = new RpcServer()
    registerMethods(server, db, engine)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('parses SSE responses and returns discovered capabilities', async () => {
    const srv = repo.create({
      name: 'feishu-project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer token' },
    })

    mockSuccessfulSseProbe()

    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'mcp.test',
        params: { id: srv.id },
      }),
    )
    const parsed = JSON.parse(raw)

    expect(parsed.error).toBeUndefined()
    expect(parsed.result.ok).toBe(true)
    expect(parsed.result.capabilities.tools.count).toBe(2)
    expect(parsed.result.capabilities.resources.count).toBe(1)
    expect(parsed.result.capabilities.prompts.count).toBe(1)
    expect(parsed.result.capabilities.tools.items[0]).toMatchObject({
      name: 'project.search',
      description: 'Search project items',
    })
  })

  it('persists probe details after testing a server', async () => {
    const srv = repo.create({
      name: 'feishu-project',
      transport: 'sse',
      url: 'https://example.com/sse',
    })

    mockSuccessfulSseProbe()

    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'mcp.test',
        params: { id: srv.id },
      }),
    )

    const updated = repo.findById(srv.id)!
    expect(updated.last_test_status).toBe('success')
    expect(updated.last_test_error).toBeNull()
    expect(updated.capabilities_json).toContain('project.search')
    expect(updated.capabilities_summary).toContain('project.search')
  })

  it('auto-probes new servers on create', async () => {
    mockSuccessfulSseProbe()

    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'mcp.create',
        params: {
          name: 'feishu-project',
          transport: 'sse',
          url: 'https://example.com/sse',
        },
      }),
    )
    const parsed = JSON.parse(raw)

    expect(parsed.error).toBeUndefined()
    expect(parsed.result.last_test_status).toBe('success')
    expect(parsed.result.capabilities_json).toContain('project.search')

    const created = repo.findByName('feishu-project')!
    expect(created.last_test_status).toBe('success')
    expect(created.capabilities_summary).toContain('project.search')
  })

  it('persists the last error when probing fails', async () => {
    const srv = repo.create({
      name: 'broken-sse',
      transport: 'sse',
      url: 'https://example.com/broken',
    })

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'mcp.test',
        params: { id: srv.id },
      }),
    )
    const parsed = JSON.parse(raw)

    expect(parsed.error).toBeUndefined()
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error).toContain('network down')

    const updated = repo.findById(srv.id)!
    expect(updated.last_test_status).toBe('error')
    expect(updated.last_test_error).toContain('network down')
    expect(updated.capabilities_json).toBeNull()
    expect(updated.capabilities_summary).toBeNull()
  })

  it('starts oauth authorization and persists tokens after poll succeeds', async () => {
    const srv = repo.create({
      name: 'oauth-mcp',
      transport: 'http',
      url: 'https://mcp.example.com/team/mcp',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp') {
        return new Response(JSON.stringify({
          resource: 'https://mcp.example.com/team/mcp',
          authorization_servers: ['https://auth.example.com/tenant'],
          scopes_supported: ['files:read'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.example.com/tenant',
          authorization_endpoint: 'https://auth.example.com/tenant/authorize',
          token_endpoint: 'https://auth.example.com/tenant/token',
          registration_endpoint: 'https://auth.example.com/tenant/register',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/tenant/register') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({
          client_id: 'dcr-client-id',
          redirect_uris: body.redirect_uris,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/tenant/token') {
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '')
        expect(body).toContain('grant_type=authorization_code')
        expect(body).toContain('client_id=dcr-client-id')
        return new Response(JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const startRaw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'mcp.oauthStart',
        params: { id: srv.id },
      }),
    )
    const started = JSON.parse(startRaw)

    expect(started.error).toBeUndefined()
    expect(started.result.authUrl).toContain('https://auth.example.com/tenant/authorize')
    expect(started.result.requestId).toBeTruthy()
    expect(started.result.redirectMode).toBe('deeplink')

    const completeRaw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 51,
        method: 'mcp.oauthComplete',
        params: { url: `code-agent://oauth/callback?code=oauth-code&state=${started.result.state}` },
      }),
    )
    const completed = JSON.parse(completeRaw)
    expect(completed.error).toBeUndefined()
    expect(completed.result.ok).toBe(true)

    const pollRaw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'mcp.oauthPoll',
        params: { id: srv.id, requestId: started.result.requestId },
      }),
    )
    const polled = JSON.parse(pollRaw)

    expect(polled.error).toBeUndefined()
    expect(polled.result.status).toBe('success')
    expect(polled.result.tokens.accessToken).toBe('access-token')

    const updated = repo.findById(srv.id)!
    expect(updated.oauth_client_id).toBe('dcr-client-id')
    expect(updated.oauth_access_token).toBe('access-token')
    expect(updated.oauth_refresh_token).toBe('refresh-token')
    expect(updated.oauth_token_type).toBe('Bearer')
    expect(updated.oauth_metadata_json).toContain('authorization_endpoint')
    expect(updated.oauth_connected_at).toBeTruthy()
    expect(updated.oauth_last_error).toBeNull()
  })

  it('disconnects oauth session while preserving oauth config', async () => {
    const srv = repo.create({
      name: 'oauth-mcp',
      transport: 'http',
      url: 'https://mcp.example.com/team/mcp',
      authType: 'oauth',
      oauthClientId: 'desktop-client',
    })

    repo.updateOAuthSession(srv.id, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      expiresAt: '2026-04-24T10:00:00.000Z',
      metadataJson: '{"issuer":"https://auth.example.com"}',
      connectedAt: '2026-04-23T10:00:00.000Z',
      lastError: null,
    })

    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'mcp.oauthDisconnect',
        params: { id: srv.id },
      }),
    )
    const parsed = JSON.parse(raw)

    expect(parsed.error).toBeUndefined()
    expect(parsed.result.oauth_access_token).toBeNull()
    expect(parsed.result.oauth_refresh_token).toBeNull()
    expect(parsed.result.auth_type).toBe('oauth')
    expect(parsed.result.oauth_client_id).toBe('desktop-client')
  })

  it('returns a clear oauth login required error when testing an unauthenticated oauth server', async () => {
    const srv = repo.create({
      name: 'oauth-mcp',
      transport: 'http',
      url: 'https://mcp.example.com/team/mcp',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.example.com/team/mcp') {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp", scope="files:read"',
          },
        })
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp') {
        return new Response(JSON.stringify({
          resource: 'https://mcp.example.com/team/mcp',
          authorization_servers: ['https://auth.example.com/tenant'],
          scopes_supported: ['files:read'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.example.com/tenant',
          authorization_endpoint: 'https://auth.example.com/tenant/authorize',
          token_endpoint: 'https://auth.example.com/tenant/token',
          registration_endpoint: 'https://auth.example.com/tenant/register',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'mcp.test',
        params: { id: srv.id },
      }),
    )
    const parsed = JSON.parse(raw)

    expect(parsed.error).toBeUndefined()
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error).toContain('OAuth login required')

    const updated = repo.findById(srv.id)!
    expect(updated.last_test_status).toBe('error')
    expect(updated.last_test_error).toContain('OAuth login required')
    expect(updated.oauth_auth_state).toBe('required')
    expect(updated.oauth_metadata_json).toContain('registration_endpoint')
  })

  it('marks zero-config oauth as unsupported when provider has no registration endpoint', async () => {
    const srv = repo.create({
      name: 'unsupported-oauth-mcp',
      transport: 'http',
      url: 'https://mcp.example.com/team/mcp',
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://mcp.example.com/team/mcp') {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp"',
          },
        })
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp') {
        return new Response(JSON.stringify({
          resource: 'https://mcp.example.com/team/mcp',
          authorization_servers: ['https://auth.example.com/tenant'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.example.com/tenant',
          authorization_endpoint: 'https://auth.example.com/tenant/authorize',
          token_endpoint: 'https://auth.example.com/tenant/token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'mcp.test',
        params: { id: srv.id },
      }),
    )
    const parsed = JSON.parse(raw)

    expect(parsed.error).toBeUndefined()
    expect(parsed.result.ok).toBe(false)
    expect(parsed.result.error).toContain('OAuth provider does not support zero-config login')

    const updated = repo.findById(srv.id)!
    expect(updated.last_test_status).toBe('error')
    expect(updated.last_test_error).toContain('OAuth provider does not support zero-config login')
    expect(updated.oauth_auth_state).toBe('unsupported')
  })
})
