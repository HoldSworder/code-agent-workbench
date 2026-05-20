import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { McpServerRepository } from '../../src/db/repositories/mcp-server.repo'

describe('McpServerRepository', () => {
  let db: Database.Database
  let repo: McpServerRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    repo = new McpServerRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('adds probe columns for legacy mcp_servers tables', () => {
    const legacyDb = new Database(':memory:')
    legacyDb.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        url TEXT,
        headers TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    applySchema(legacyDb)

    const columns = legacyDb.prepare(`PRAGMA table_info(mcp_servers)`).all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'last_test_status',
      'last_test_error',
      'last_tested_at',
      'capabilities_json',
      'capabilities_summary',
      'auth_type',
      'oauth_client_id',
      'oauth_scope',
      'oauth_audience',
      'oauth_token_endpoint_auth_method',
      'oauth_access_token',
      'oauth_refresh_token',
      'oauth_token_type',
      'oauth_expires_at',
      'oauth_id_token',
      'oauth_metadata_json',
      'oauth_registration_json',
      'oauth_auth_state',
      'oauth_redirect_mode',
      'oauth_last_error',
      'oauth_connected_at',
    ]))

    legacyDb.close()
  })

  it('persists probe state and capability snapshots', () => {
    const server = repo.create({
      name: 'feishu-project',
      transport: 'sse',
      url: 'https://example.com/mcp',
    })

    ;(repo as any).updateProbeResult(server.id, {
      ok: true,
      error: null,
      testedAt: '2026-04-23T14:00:00.000Z',
      capabilitiesJson: JSON.stringify({
        tools: { count: 1, items: [{ name: 'project.search', description: 'Search project items' }] },
        resources: { count: 0, items: [] },
        prompts: { count: 0, items: [] },
      }),
      capabilitiesSummary: JSON.stringify({
        tools: ['project.search'],
        resources: [],
        prompts: [],
      }),
    })

    const updated = repo.findById(server.id)!
    expect(updated.last_test_status).toBe('success')
    expect(updated.last_test_error).toBeNull()
    expect(updated.last_tested_at).toBe('2026-04-23T14:00:00.000Z')
    expect(updated.capabilities_json).toContain('project.search')
    expect(updated.capabilities_summary).toContain('project.search')
  })

  it('persists oauth registration, auth state and session state', () => {
    const server = repo.create({
      name: 'oauth-mcp',
      transport: 'http',
      url: 'https://example.com/mcp',
    })

    ;(repo as any).updateOAuthRegistration(server.id, {
      clientId: 'dcr-client-id',
      registrationJson: '{"client_id":"dcr-client-id","redirect_uris":["code-agent://oauth/callback"]}',
      redirectMode: 'deeplink',
    })

    ;(repo as any).updateOAuthSession(server.id, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      expiresAt: '2026-04-24T10:00:00.000Z',
      idToken: 'id-token',
      metadataJson: '{"issuer":"https://auth.example.com"}',
      authState: 'connected',
      lastError: null,
      connectedAt: '2026-04-23T10:00:00.000Z',
    })

    const updated = repo.findById(server.id)!
    expect(updated.oauth_client_id).toBe('dcr-client-id')
    expect(updated.oauth_access_token).toBe('access-token')
    expect(updated.oauth_refresh_token).toBe('refresh-token')
    expect(updated.oauth_token_type).toBe('Bearer')
    expect(updated.oauth_expires_at).toBe('2026-04-24T10:00:00.000Z')
    expect(updated.oauth_id_token).toBe('id-token')
    expect(updated.oauth_metadata_json).toContain('auth.example.com')
    expect(updated.oauth_registration_json).toContain('dcr-client-id')
    expect(updated.oauth_auth_state).toBe('connected')
    expect(updated.oauth_redirect_mode).toBe('deeplink')
    expect(updated.oauth_last_error).toBeNull()
    expect(updated.oauth_connected_at).toBe('2026-04-23T10:00:00.000Z')
  })

  it('clears oauth session without touching oauth registration', () => {
    const server = repo.create({
      name: 'oauth-mcp',
      transport: 'http',
      url: 'https://example.com/mcp',
    })

    ;(repo as any).updateOAuthRegistration(server.id, {
      clientId: 'dcr-client-id',
      registrationJson: '{"client_id":"dcr-client-id","redirect_uris":["code-agent://oauth/callback"]}',
      redirectMode: 'loopback',
    })

    ;(repo as any).updateOAuthSession(server.id, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'Bearer',
      expiresAt: '2026-04-24T10:00:00.000Z',
      metadataJson: '{"issuer":"https://auth.example.com"}',
      authState: 'connected',
      lastError: 'old error',
      connectedAt: '2026-04-23T10:00:00.000Z',
    })

    ;(repo as any).clearOAuthSession(server.id)

    const updated = repo.findById(server.id)!
    expect(updated.oauth_client_id).toBe('dcr-client-id')
    expect(updated.oauth_registration_json).toContain('dcr-client-id')
    expect(updated.oauth_access_token).toBeNull()
    expect(updated.oauth_refresh_token).toBeNull()
    expect(updated.oauth_token_type).toBeNull()
    expect(updated.oauth_expires_at).toBeNull()
    expect(updated.oauth_id_token).toBeNull()
    expect(updated.oauth_last_error).toBeNull()
    expect(updated.oauth_connected_at).toBeNull()
    expect(updated.oauth_auth_state).toBe('required')
    expect(updated.oauth_redirect_mode).toBe('loopback')
  })
})
