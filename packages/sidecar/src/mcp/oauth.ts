import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export interface OAuthProtectedResourceMetadata {
  resource?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

export interface OAuthAuthorizationServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  client_id_metadata_document_supported?: boolean
  token_endpoint_auth_methods_supported?: string[]
}

export interface McpOAuthMetadataBundle {
  resource: OAuthProtectedResourceMetadata
  authorizationServer: OAuthAuthorizationServerMetadata
  protectedResourceMetadataUrl?: string
  authorizationServerMetadataUrl?: string
  scopeHint?: string | null
}

export interface OAuthTokenSet {
  accessToken: string
  refreshToken: string | null
  tokenType: string | null
  expiresAt: string | null
  idToken: string | null
}

export interface OAuthClientRegistration {
  clientId: string
  redirectUris: string[]
  registrationAccessToken?: string | null
  registrationClientUri?: string | null
  raw?: Record<string, unknown> | null
}

export interface StartAuthorizationInput {
  mcpUrl: string
  scope?: string | null
  audience?: string | null
  tokenEndpointAuthMethod?: string | null
  deepLinkScheme?: string
  clientName?: string
  registration?: OAuthClientRegistration | null
}

export interface StartAuthorizationResult {
  requestId: string
  authUrl: string
  callbackPort: number
  redirectUri: string
  state: string
  redirectMode: 'deeplink' | 'loopback'
  deepLinkRedirectUri: string
  loopbackRedirectUri: string
  registration: OAuthClientRegistration
  metadata: McpOAuthMetadataBundle
}

export interface RefreshTokenInput {
  mcpUrl: string
  clientId: string
  refreshToken: string
  audience?: string | null
  metadata: McpOAuthMetadataBundle
}

export interface OAuthSessionContext {
  mcpUrl: string
  clientId: string | null
  accessToken: string | null
  refreshToken: string | null
  expiresAt: string | null
  audience?: string | null
  metadata: McpOAuthMetadataBundle | null
}

export interface AuthorizationPollResult {
  status: 'pending' | 'success' | 'error'
  tokens?: OAuthTokenSet
  error?: string
  registration?: OAuthClientRegistration
  metadata: McpOAuthMetadataBundle
}

export interface OAuthRequirementDetectionResult {
  authState: 'required' | 'unsupported'
  error: string
  metadata: McpOAuthMetadataBundle
}

interface BearerChallenge {
  resourceMetadata?: string
  scope?: string
  error?: string
  errorDescription?: string
}

interface PendingAuthorization {
  requestId: string
  state: string
  resource: string
  codeVerifier: string
  redirectUri: string
  redirectMode: 'deeplink' | 'loopback'
  deepLinkRedirectUri: string
  loopbackRedirectUri: string
  callbackPort: number
  metadata: McpOAuthMetadataBundle
  registration: OAuthClientRegistration
  audience?: string | null
  status: 'pending' | 'success' | 'error'
  expiresAt: number
  tokens?: OAuthTokenSet
  error?: string
  server: Server
}

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'code-agent-auth', version: '0.1.0' },
  },
}

function toBase64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createCodeVerifier(): string {
  return toBase64Url(randomBytes(32))
}

function createCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash('sha256').update(codeVerifier).digest())
}

export function buildProtectedResourceMetadataCandidates(resourceUrl: string): string[] {
  const url = new URL(resourceUrl)
  const origin = url.origin
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  const candidates: string[] = []
  if (path)
    candidates.push(`${origin}/.well-known/oauth-protected-resource/${path}`)
  candidates.push(`${origin}/.well-known/oauth-protected-resource`)
  return Array.from(new Set(candidates))
}

export function buildAuthorizationServerMetadataCandidates(issuer: string): string[] {
  const url = new URL(issuer)
  const origin = url.origin
  const normalizedPath = url.pathname.replace(/\/+$/, '')

  if (!normalizedPath || normalizedPath === '/') {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ]
  }

  return [
    `${origin}/.well-known/oauth-authorization-server${normalizedPath}`,
    `${origin}/.well-known/openid-configuration${normalizedPath}`,
    `${origin}${normalizedPath}/.well-known/openid-configuration`,
  ]
}

function parseBearerChallenge(header: string | null): BearerChallenge {
  if (!header) return {}
  const lowerHeader = header.toLowerCase()
  if (!lowerHeader.includes('bearer')) return {}

  const result: BearerChallenge = {}
  for (const key of ['resource_metadata', 'scope', 'error', 'error_description'] as const) {
    const quoted = new RegExp(`${key}="([^"]*)"`, 'i').exec(header)
    if (quoted?.[1]) {
      const value = quoted[1]
      if (key === 'resource_metadata') result.resourceMetadata = value
      if (key === 'scope') result.scope = value
      if (key === 'error') result.error = value
      if (key === 'error_description') result.errorDescription = value
      continue
    }

    const plain = new RegExp(`${key}=([^,\\s]+)`, 'i').exec(header)
    if (!plain?.[1]) continue
    const value = plain[1]
    if (key === 'resource_metadata') result.resourceMetadata = value
    if (key === 'scope') result.scope = value
    if (key === 'error') result.error = value
    if (key === 'error_description') result.errorDescription = value
  }
  return result
}

function canonicalizeResource(resourceUrl: string): string {
  const url = new URL(resourceUrl)
  url.hash = ''
  url.search = ''
  if (url.pathname === '/') url.pathname = ''
  return url.toString()
}

function normalizeExpiresAt(expiresIn?: unknown, explicitExpiresAt?: unknown): string | null {
  if (typeof explicitExpiresAt === 'string') return explicitExpiresAt
  if (typeof expiresIn !== 'number') return null
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const expiresAtMs = new Date(expiresAt).getTime()
  if (Number.isNaN(expiresAtMs)) return false
  return expiresAtMs <= Date.now() + 15_000
}

async function fetchJsonOrThrow(url: string): Promise<any> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return response.json()
}

async function tryFetchJson(url: string): Promise<{ ok: true, body: any } | { ok: false }> {
  try {
    const body = await fetchJsonOrThrow(url)
    return { ok: true, body }
  }
  catch {
    return { ok: false }
  }
}

async function discoverChallenge(mcpUrl: string): Promise<BearerChallenge | null> {
  try {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(INITIALIZE_BODY),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 401) return null
    return parseBearerChallenge(response.headers.get('www-authenticate'))
  }
  catch {
    return null
  }
}

async function discoverProtectedResourceMetadata(mcpUrl: string): Promise<{ metadata: OAuthProtectedResourceMetadata, metadataUrl: string, scopeHint: string | null }> {
  const challenge = await discoverChallenge(mcpUrl)
  const candidates = challenge?.resourceMetadata
    ? [challenge.resourceMetadata]
    : buildProtectedResourceMetadataCandidates(mcpUrl)

  for (const candidate of candidates) {
    const response = await tryFetchJson(candidate)
    if (!response.ok) continue
    return {
      metadata: response.body as OAuthProtectedResourceMetadata,
      metadataUrl: candidate,
      scopeHint: challenge?.scope ?? null,
    }
  }

  throw new Error('Unable to discover protected resource metadata')
}

export async function detectOAuthRequirement(mcpUrl: string): Promise<OAuthRequirementDetectionResult | null> {
  const challenge = await discoverChallenge(mcpUrl)
  if (!challenge) return null

  const { metadata: resourceMetadata, metadataUrl, scopeHint } = await discoverProtectedResourceMetadata(mcpUrl)
  const authorizationServer = resourceMetadata.authorization_servers?.[0]
  if (!authorizationServer) {
    throw new Error('Protected resource metadata missing authorization_servers')
  }

  const { metadata: authServerMetadata, metadataUrl: authServerMetadataUrl } = await discoverAuthorizationServerMetadata(authorizationServer)
  const metadataBundle: McpOAuthMetadataBundle = {
    resource: resourceMetadata,
    authorizationServer: authServerMetadata,
    protectedResourceMetadataUrl: metadataUrl,
    authorizationServerMetadataUrl: authServerMetadataUrl,
    scopeHint,
  }

  if (!supportsZeroConfigLogin(authServerMetadata)) {
    return {
      authState: 'unsupported',
      error: 'OAuth provider does not support zero-config login',
      metadata: metadataBundle,
    }
  }

  return {
    authState: 'required',
    error: 'OAuth login required',
    metadata: metadataBundle,
  }
}

async function discoverAuthorizationServerMetadata(issuer: string): Promise<{ metadata: OAuthAuthorizationServerMetadata, metadataUrl: string }> {
  for (const candidate of buildAuthorizationServerMetadataCandidates(issuer)) {
    const response = await tryFetchJson(candidate)
    if (!response.ok) continue
    return {
      metadata: response.body as OAuthAuthorizationServerMetadata,
      metadataUrl: candidate,
    }
  }

  throw new Error(`Unable to discover authorization server metadata for ${issuer}`)
}

function supportsZeroConfigLogin(metadata: OAuthAuthorizationServerMetadata): boolean {
  return typeof metadata.registration_endpoint === 'string' && metadata.registration_endpoint.length > 0
}

function buildScope(explicitScope: string | null | undefined, metadata: OAuthProtectedResourceMetadata, scopeHint?: string | null): string | null {
  if (explicitScope) return explicitScope
  if (scopeHint) return scopeHint
  if (Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.length > 0)
    return metadata.scopes_supported.join(' ')
  return null
}

function parseTokenResponse(body: any): OAuthTokenSet {
  if (typeof body?.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('OAuth token response missing access_token')
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : null,
    tokenType: typeof body?.token_type === 'string' ? body.token_type : null,
    expiresAt: normalizeExpiresAt(body?.expires_in, body?.expires_at),
    idToken: typeof body?.id_token === 'string' ? body.id_token : null,
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function extractErrorMessage(body: Record<string, unknown> | null, fallback: string): string {
  if (typeof body?.error_description === 'string' && body.error_description.length > 0)
    return body.error_description
  if (typeof body?.error === 'string' && body.error.length > 0)
    return body.error
  return fallback
}

function looksLikeRedirectUriError(body: Record<string, unknown> | null): boolean {
  const error = typeof body?.error === 'string' ? body.error : ''
  const description = typeof body?.error_description === 'string' ? body.error_description : ''
  const message = `${error} ${description}`.toLowerCase()
  return message.includes('redirect') || message.includes('custom scheme')
}

async function registerDynamicClient(
  registrationEndpoint: string,
  clientName: string,
  redirectUris: string[],
  tokenEndpointAuthMethod = 'none',
): Promise<OAuthClientRegistration> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_name: clientName,
      application_type: 'native',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      redirect_uris: redirectUris,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  const json = parseJsonObject(await response.json().catch(() => null))
  if (!response.ok) {
    const error = new Error(extractErrorMessage(json, `HTTP ${response.status}`))
    ;(error as Error & { body?: Record<string, unknown> | null }).body = json
    throw error
  }

  const clientId = typeof json?.client_id === 'string' ? json.client_id : null
  if (!clientId) throw new Error('Dynamic client registration response missing client_id')

  const acceptedRedirectUris = Array.isArray(json?.redirect_uris)
    ? json.redirect_uris.filter((item): item is string => typeof item === 'string')
    : redirectUris

  return {
    clientId,
    redirectUris: acceptedRedirectUris,
    registrationAccessToken: typeof json?.registration_access_token === 'string' ? json.registration_access_token : null,
    registrationClientUri: typeof json?.registration_client_uri === 'string' ? json.registration_client_uri : null,
    raw: json,
  }
}

async function exchangeToken(params: URLSearchParams, tokenEndpoint: string): Promise<OAuthTokenSet> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: params,
    signal: AbortSignal.timeout(15_000),
  })

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof json?.error_description === 'string'
      ? json.error_description
      : (typeof json?.error === 'string' ? json.error : `HTTP ${response.status}`)
    throw new Error(message)
  }

  return parseTokenResponse(json)
}

function buildSuccessPage(): string {
  return '<!doctype html><html><body style="font-family: sans-serif; padding: 24px;"><h2>OAuth 登录成功</h2><p>可以返回 Code Agent 继续操作。</p></body></html>'
}

function buildErrorPage(message: string): string {
  return `<!doctype html><html><body style="font-family: sans-serif; padding: 24px;"><h2>OAuth 登录失败</h2><p>${message}</p></body></html>`
}

export class McpOAuthService {
  private readonly pending = new Map<string, PendingAuthorization>()

  async startAuthorization(input: StartAuthorizationInput): Promise<StartAuthorizationResult> {
    const { metadata: resourceMetadata, metadataUrl, scopeHint } = await discoverProtectedResourceMetadata(input.mcpUrl)
    const authorizationServer = resourceMetadata.authorization_servers?.[0]
    if (!authorizationServer) throw new Error('Protected resource metadata missing authorization_servers')

    const { metadata: authServerMetadata, metadataUrl: authServerMetadataUrl } = await discoverAuthorizationServerMetadata(authorizationServer)
    if (!authServerMetadata.authorization_endpoint || !authServerMetadata.token_endpoint) {
      throw new Error('Authorization server metadata is incomplete')
    }
    if (!supportsZeroConfigLogin(authServerMetadata)) {
      throw new Error('OAuth provider does not support zero-config login')
    }

    const requestId = randomUUID()
    const state = randomUUID()
    const codeVerifier = createCodeVerifier()
    const codeChallenge = createCodeChallenge(codeVerifier)
    const resource = canonicalizeResource(input.mcpUrl)
    const deepLinkScheme = input.deepLinkScheme ?? 'code-agent'
    const deepLinkRedirectUri = `${deepLinkScheme}://oauth/callback`
    const metadataBundle: McpOAuthMetadataBundle = {
      resource: resourceMetadata,
      authorizationServer: authServerMetadata,
      protectedResourceMetadataUrl: metadataUrl,
      authorizationServerMetadataUrl: authServerMetadataUrl,
      scopeHint,
    }

    const server = createServer(async (req, res) => {
      const current = this.pending.get(requestId)
      if (!current) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(buildErrorPage('授权请求已失效'))
        return
      }

      try {
        const requestUrl = new URL(req.url ?? '/', current.loopbackRedirectUri)
        await this.completeAuthorization(requestUrl.toString())

        const updated = this.pending.get(requestId)
        if (updated?.status === 'success') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(buildSuccessPage())
          return
        }

        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(buildErrorPage(updated?.error ?? 'OAuth callback failed'))
      }
      catch (error) {
        current.status = 'error'
        current.error = error instanceof Error ? error.message : 'OAuth callback failed'
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(buildErrorPage(current.error))
      }
      finally {
        current.server.close()
      }
    })

    const callbackPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to bind OAuth callback server'))
          return
        }
        resolve(address.port)
      })
    })

    const loopbackRedirectUri = `http://127.0.0.1:${callbackPort}/oauth/callback`
    const redirectModeFallback = 'loopback'
    const clientName = input.clientName ?? 'Code Agent'
    let registration = input.registration ?? null
    let redirectMode: 'deeplink' | 'loopback' = redirectModeFallback

    try {
      if (!registration) {
        try {
          registration = await registerDynamicClient(
            authServerMetadata.registration_endpoint!,
            clientName,
            [deepLinkRedirectUri, loopbackRedirectUri],
            input.tokenEndpointAuthMethod ?? 'none',
          )
        }
        catch (error) {
          const body = parseJsonObject((error as Error & { body?: Record<string, unknown> | null }).body ?? null)
          if (!looksLikeRedirectUriError(body)) throw error
          registration = await registerDynamicClient(
            authServerMetadata.registration_endpoint!,
            clientName,
            [loopbackRedirectUri],
            input.tokenEndpointAuthMethod ?? 'none',
          )
        }
      }

      const acceptedRedirectUris = registration.redirectUris
      redirectMode = acceptedRedirectUris.includes(deepLinkRedirectUri) ? 'deeplink' : 'loopback'
      const redirectUri = redirectMode === 'deeplink' ? deepLinkRedirectUri : loopbackRedirectUri

      const scope = buildScope(input.scope, resourceMetadata, scopeHint)
      const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: registration.clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        resource,
      })
      if (scope) authParams.set('scope', scope)
      if (input.audience) authParams.set('audience', input.audience)

      this.pending.set(requestId, {
        requestId,
        state,
        resource,
        codeVerifier,
        redirectUri,
        redirectMode,
        deepLinkRedirectUri,
        loopbackRedirectUri,
        callbackPort,
        metadata: metadataBundle,
        registration,
        audience: input.audience,
        status: 'pending',
        expiresAt: Date.now() + 10 * 60 * 1000,
        server,
      })

      return {
        requestId,
        authUrl: `${authServerMetadata.authorization_endpoint}?${authParams.toString()}`,
        callbackPort,
        redirectUri,
        redirectMode,
        deepLinkRedirectUri,
        loopbackRedirectUri,
        state,
        registration,
        metadata: metadataBundle,
      }
    }
    catch (error) {
      server.close()
      throw error
    }
  }

  async completeAuthorization(callbackUrl: string): Promise<void> {
    const url = new URL(callbackUrl)
    const state = url.searchParams.get('state')
    if (!state) throw new Error('OAuth state is missing')

    const current = Array.from(this.pending.values()).find(item => item.state === state)
    if (!current) throw new Error('OAuth request not found for callback state')

    const code = url.searchParams.get('code')
    const callbackState = url.searchParams.get('state')
    const callbackError = url.searchParams.get('error')

    if (callbackError) {
      current.status = 'error'
      current.error = callbackError
      current.server.close()
      return
    }

    if (!code) throw new Error('Missing authorization code')
    if (callbackState !== current.state) throw new Error('OAuth state mismatch')

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: current.registration.clientId,
      code,
      redirect_uri: current.redirectUri,
      code_verifier: current.codeVerifier,
      resource: current.resource,
    })
    if (current.audience) tokenParams.set('audience', current.audience)

    try {
      const tokens = await exchangeToken(tokenParams, current.metadata.authorizationServer.token_endpoint)
      current.status = 'success'
      current.tokens = tokens
      current.error = undefined
    }
    catch (error) {
      current.status = 'error'
      current.error = error instanceof Error ? error.message : 'OAuth callback failed'
      throw error
    }
    finally {
      current.server.close()
    }
  }

  pollAuthorization(requestId: string): AuthorizationPollResult {
    const current = this.pending.get(requestId)
    if (!current) throw new Error(`OAuth request not found: ${requestId}`)

    if (current.status === 'pending' && current.expiresAt <= Date.now()) {
      current.status = 'error'
      current.error = 'OAuth authorization timed out'
      current.server.close()
    }

    if (current.status === 'success') {
      return {
        status: 'success',
        tokens: current.tokens,
        registration: current.registration,
        metadata: current.metadata,
      }
    }

    if (current.status === 'error') {
      return {
        status: 'error',
        error: current.error ?? 'OAuth authorization failed',
        registration: current.registration,
        metadata: current.metadata,
      }
    }

    return {
      status: 'pending',
      registration: current.registration,
      metadata: current.metadata,
    }
  }

  async refreshToken(input: RefreshTokenInput): Promise<OAuthTokenSet> {
    const resource = canonicalizeResource(input.mcpUrl)
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource,
    })
    if (input.audience) params.set('audience', input.audience)
    return exchangeToken(params, input.metadata.authorizationServer.token_endpoint)
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.pending.values()).map(entry =>
      new Promise<void>((resolve) => {
        entry.server.close(() => resolve())
      }),
    ))
    this.pending.clear()
  }
}

export async function resolveOAuthAccessToken(
  input: OAuthSessionContext,
  refreshAccessToken: (input: RefreshTokenInput) => Promise<OAuthTokenSet>,
): Promise<{ accessToken: string, refreshedTokens?: OAuthTokenSet }> {
  if (!input.clientId) throw new Error('OAuth client_id is required')

  if (input.accessToken && !isExpired(input.expiresAt)) {
    return { accessToken: input.accessToken }
  }

  if (!input.refreshToken) {
    throw new Error(input.accessToken ? 'OAuth access token expired, please log in again' : 'OAuth login required')
  }

  if (!input.metadata) throw new Error('OAuth metadata is missing')

  const refreshedTokens = await refreshAccessToken({
    mcpUrl: input.mcpUrl,
    clientId: input.clientId,
    refreshToken: input.refreshToken,
    audience: input.audience,
    metadata: input.metadata,
  })

  return {
    accessToken: refreshedTokens.accessToken,
    refreshedTokens,
  }
}
