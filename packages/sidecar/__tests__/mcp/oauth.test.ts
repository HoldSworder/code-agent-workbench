import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'node:http'
import {
  McpOAuthService,
  buildAuthorizationServerMetadataCandidates,
  buildProtectedResourceMetadataCandidates,
} from '../../src/mcp/oauth'

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

describe('McpOAuthService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds protected resource and authorization server discovery candidates', () => {
    expect(buildProtectedResourceMetadataCandidates('https://mcp.example.com/public/mcp')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    ])

    expect(buildAuthorizationServerMetadataCandidates('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ])
  })

  it('registers a client dynamically and prefers deep link redirect', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
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
        expect(body.application_type).toBe('native')
        expect(body.token_endpoint_auth_method).toBe('none')
        expect(body.redirect_uris).toEqual(expect.arrayContaining([
          'code-agent://oauth/callback',
        ]))
        expect(body.redirect_uris.some((item: string) => item.startsWith('http://127.0.0.1:'))).toBe(true)
        return new Response(JSON.stringify({
          client_id: 'dcr-client-id',
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'none',
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/tenant/token') {
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '')
        expect(body).toContain('grant_type=authorization_code')
        expect(body).toContain('code=auth-code')
        expect(body).toContain('client_id=dcr-client-id')
        expect(body).toContain('redirect_uri=code-agent%3A%2F%2Foauth%2Fcallback')
        expect(body).toContain('resource=https%3A%2F%2Fmcp.example.com%2Fteam%2Fmcp')
        return new Response(JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: 'id-token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const service = new McpOAuthService()
    const started = await service.startAuthorization({
      mcpUrl: 'https://mcp.example.com/team/mcp',
    })

    expect(fetchMock).toHaveBeenCalled()
    expect(started.authUrl).toContain('https://auth.example.com/tenant/authorize')
    expect(started.authUrl).toContain('client_id=dcr-client-id')
    expect(started.authUrl).toContain('response_type=code')
    expect(started.authUrl).toContain('code_challenge=')
    expect(started.authUrl).toContain('resource=https%3A%2F%2Fmcp.example.com%2Fteam%2Fmcp')
    expect(started.authUrl).toContain('redirect_uri=code-agent%3A%2F%2Foauth%2Fcallback')
    expect(started.redirectMode).toBe('deeplink')
    expect(started.redirectUri).toBe('code-agent://oauth/callback')

    await service.completeAuthorization(`code-agent://oauth/callback?code=auth-code&state=${started.state}`)

    const polled = service.pollAuthorization(started.requestId)
    expect(polled.status).toBe('success')
    expect(polled.tokens?.accessToken).toBe('access-token')
    expect(polled.tokens?.refreshToken).toBe('refresh-token')
    expect(polled.metadata.authorizationServer.authorization_endpoint).toBe('https://auth.example.com/tenant/authorize')
    expect(polled.registration?.clientId).toBe('dcr-client-id')

    await service.dispose()
  })

  it('falls back to loopback redirect when deep link registration is rejected', async () => {
    const registrationBodies: Array<{ redirect_uris: string[] }> = []

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
        registrationBodies.push(body)
        if (body.redirect_uris.includes('code-agent://oauth/callback')) {
          return new Response(JSON.stringify({
            error: 'invalid_redirect_uri',
            error_description: 'custom scheme is not allowed',
          }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        }

        expect(body.redirect_uris).toHaveLength(1)
        expect(body.redirect_uris[0].startsWith('http://127.0.0.1:')).toBe(true)

        return new Response(JSON.stringify({
          client_id: 'loopback-client-id',
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'none',
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/tenant/token') {
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '')
        expect(body).toContain('client_id=loopback-client-id')
        expect(body).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A')
        return new Response(JSON.stringify({
          access_token: 'loopback-access-token',
          refresh_token: 'loopback-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const service = new McpOAuthService()
    const started = await service.startAuthorization({
      mcpUrl: 'https://mcp.example.com/team/mcp',
    })

    expect(registrationBodies).toHaveLength(2)
    expect(started.redirectMode).toBe('loopback')
    expect(started.redirectUri.startsWith('http://127.0.0.1:')).toBe(true)

    const callback = new URL(started.redirectUri)
    const response = await readResponse(`http://127.0.0.1:${callback.port}${callback.pathname}?code=loopback-code&state=${started.state}`)
    expect(response.statusCode).toBe(200)

    const polled = service.pollAuthorization(started.requestId)
    expect(polled.status).toBe('success')
    expect(polled.tokens?.accessToken).toBe('loopback-access-token')
    expect(polled.registration?.clientId).toBe('loopback-client-id')

    await service.dispose()
  })

  it('refreshes an expired access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://auth.example.com/token') {
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '')
        expect(body).toContain('grant_type=refresh_token')
        expect(body).toContain('refresh_token=refresh-token')
        return new Response(JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          token_type: 'Bearer',
          expires_in: 1800,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const service = new McpOAuthService()
    const refreshed = await service.refreshToken({
      mcpUrl: 'https://mcp.example.com/team/mcp',
      clientId: 'desktop-client',
      refreshToken: 'refresh-token',
      metadata: {
        resource: { resource: 'https://mcp.example.com/team/mcp', authorization_servers: ['https://auth.example.com'] },
        authorizationServer: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        },
      },
    })

    expect(refreshed.accessToken).toBe('new-access-token')
    expect(refreshed.refreshToken).toBe('new-refresh-token')
    expect(refreshed.tokenType).toBe('Bearer')

    await service.dispose()
  })

  it('returns unsupported when provider has no registration endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
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

    const service = new McpOAuthService()
    await expect(service.startAuthorization({
      mcpUrl: 'https://mcp.example.com/team/mcp',
    })).rejects.toThrow('OAuth provider does not support zero-config login')

    await service.dispose()
  })

  it('returns an error when deep link callback fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
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
          registration_endpoint: 'https://auth.example.com/tenant/register',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/tenant/register') {
        return new Response(JSON.stringify({
          client_id: 'dcr-client-id',
          redirect_uris: ['code-agent://oauth/callback'],
          token_endpoint_auth_method: 'none',
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      if (url === 'https://auth.example.com/tenant/token') {
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '')
        expect(body).toContain('client_id=dcr-client-id')
        return new Response(JSON.stringify({
          access_token: 'access-token',
          token_type: 'Bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const service = new McpOAuthService()
    const started = await service.startAuthorization({
      mcpUrl: 'https://mcp.example.com/team/mcp',
    })

    await service.completeAuthorization(`code-agent://oauth/callback?error=access_denied&state=${started.state}`)

    const polled = service.pollAuthorization(started.requestId)
    expect(polled.status).toBe('error')
    expect(polled.error).toContain('access_denied')

    await service.dispose()
  })
})
