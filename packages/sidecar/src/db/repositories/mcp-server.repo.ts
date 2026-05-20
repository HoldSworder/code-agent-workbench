import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface McpServer {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  command: string | null
  args: string
  env: string
  url: string | null
  headers: string
  enabled: number
  last_test_status: 'success' | 'error' | null
  last_test_error: string | null
  last_tested_at: string | null
  capabilities_json: string | null
  capabilities_summary: string | null
  auth_type: 'oauth' | null
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
  oauth_auth_state: 'none' | 'required' | 'connected' | 'unsupported' | 'error' | null
  oauth_redirect_mode: 'deeplink' | 'loopback' | null
  oauth_last_error: string | null
  oauth_connected_at: string | null
  created_at: string
  updated_at: string
}

export interface UpdateMcpProbeResultInput {
  ok: boolean
  error?: string | null
  testedAt: string
  capabilitiesJson?: string | null
  capabilitiesSummary?: string | null
}

export interface CreateMcpServerInput {
  name: string
  description?: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  authType?: 'oauth' | null
  oauthClientId?: string | null
  oauthScope?: string | null
  oauthAudience?: string | null
  oauthTokenEndpointAuthMethod?: string | null
}

export interface UpdateMcpServerInput {
  name?: string
  description?: string
  transport?: 'stdio' | 'http' | 'sse'
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
  enabled?: boolean
  authType?: 'oauth' | null
  oauthClientId?: string | null
  oauthScope?: string | null
  oauthAudience?: string | null
  oauthTokenEndpointAuthMethod?: string | null
}

export interface UpdateMcpOAuthConfigInput {
  authType?: 'oauth' | null
  clientId?: string | null
  scope?: string | null
  audience?: string | null
  tokenEndpointAuthMethod?: string | null
}

export interface UpdateMcpOAuthSessionInput {
  accessToken?: string | null
  refreshToken?: string | null
  tokenType?: string | null
  expiresAt?: string | null
  idToken?: string | null
  metadataJson?: string | null
  registrationJson?: string | null
  authState?: 'none' | 'required' | 'connected' | 'unsupported' | 'error' | null
  redirectMode?: 'deeplink' | 'loopback' | null
  lastError?: string | null
  connectedAt?: string | null
}

export interface UpdateMcpOAuthRegistrationInput {
  clientId?: string | null
  registrationJson?: string | null
  redirectMode?: 'deeplink' | 'loopback' | null
}

export class McpServerRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateMcpServerInput): McpServer {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO mcp_servers (
        id, name, description, transport, command, args, env, url, headers, enabled,
        auth_type, oauth_client_id, oauth_scope, oauth_audience, oauth_token_endpoint_auth_method
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description ?? '',
      input.transport,
      input.command ?? null,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.env ?? {}),
      input.url ?? null,
      JSON.stringify(input.headers ?? {}),
      input.enabled === false ? 0 : 1,
      input.authType ?? null,
      input.oauthClientId ?? null,
      input.oauthScope ?? null,
      input.oauthAudience ?? null,
      input.oauthTokenEndpointAuthMethod ?? null,
    )
    return this.findById(id)!
  }

  update(id: string, input: UpdateMcpServerInput): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    const fields: string[] = []
    const values: unknown[] = []

    if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name) }
    if (input.description !== undefined) { fields.push('description = ?'); values.push(input.description) }
    if (input.transport !== undefined) { fields.push('transport = ?'); values.push(input.transport) }
    if (input.command !== undefined) { fields.push('command = ?'); values.push(input.command) }
    if (input.args !== undefined) { fields.push('args = ?'); values.push(JSON.stringify(input.args)) }
    if (input.env !== undefined) { fields.push('env = ?'); values.push(JSON.stringify(input.env)) }
    if (input.url !== undefined) { fields.push('url = ?'); values.push(input.url) }
    if (input.headers !== undefined) { fields.push('headers = ?'); values.push(JSON.stringify(input.headers)) }
    if (input.enabled !== undefined) { fields.push('enabled = ?'); values.push(input.enabled ? 1 : 0) }
    if (input.authType !== undefined) { fields.push('auth_type = ?'); values.push(input.authType) }
    if (input.oauthClientId !== undefined) { fields.push('oauth_client_id = ?'); values.push(input.oauthClientId) }
    if (input.oauthScope !== undefined) { fields.push('oauth_scope = ?'); values.push(input.oauthScope) }
    if (input.oauthAudience !== undefined) { fields.push('oauth_audience = ?'); values.push(input.oauthAudience) }
    if (input.oauthTokenEndpointAuthMethod !== undefined) { fields.push('oauth_token_endpoint_auth_method = ?'); values.push(input.oauthTokenEndpointAuthMethod) }

    if (fields.length === 0) return current

    fields.push("updated_at = datetime('now')")
    values.push(id)

    this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.findById(id)!
  }

  findById(id: string): McpServer | undefined {
    return this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServer | undefined
  }

  findByName(name: string): McpServer | undefined {
    return this.db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as McpServer | undefined
  }

  findAll(): McpServer[] {
    return this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as McpServer[]
  }

  findEnabled(): McpServer[] {
    return this.db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC').all() as McpServer[]
  }

  toggle(id: string): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)
    this.db.prepare("UPDATE mcp_servers SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .run(current.enabled ? 0 : 1, id)
    return this.findById(id)!
  }

  updateProbeResult(id: string, input: UpdateMcpProbeResultInput): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    this.db.prepare(`
      UPDATE mcp_servers
      SET
        last_test_status = ?,
        last_test_error = ?,
        last_tested_at = ?,
        capabilities_json = ?,
        capabilities_summary = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      input.ok ? 'success' : 'error',
      input.error ?? null,
      input.testedAt,
      input.capabilitiesJson ?? null,
      input.capabilitiesSummary ?? null,
      id,
    )

    return this.findById(id)!
  }

  updateOAuthConfig(id: string, input: UpdateMcpOAuthConfigInput): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    const fields: string[] = []
    const values: unknown[] = []

    if (input.authType !== undefined) { fields.push('auth_type = ?'); values.push(input.authType) }
    if (input.clientId !== undefined) { fields.push('oauth_client_id = ?'); values.push(input.clientId) }
    if (input.scope !== undefined) { fields.push('oauth_scope = ?'); values.push(input.scope) }
    if (input.audience !== undefined) { fields.push('oauth_audience = ?'); values.push(input.audience) }
    if (input.tokenEndpointAuthMethod !== undefined) { fields.push('oauth_token_endpoint_auth_method = ?'); values.push(input.tokenEndpointAuthMethod) }

    if (fields.length === 0) return current

    fields.push("updated_at = datetime('now')")
    values.push(id)

    this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.findById(id)!
  }

  updateOAuthSession(id: string, input: UpdateMcpOAuthSessionInput): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    const fields: string[] = []
    const values: unknown[] = []

    if (input.accessToken !== undefined) { fields.push('oauth_access_token = ?'); values.push(input.accessToken) }
    if (input.refreshToken !== undefined) { fields.push('oauth_refresh_token = ?'); values.push(input.refreshToken) }
    if (input.tokenType !== undefined) { fields.push('oauth_token_type = ?'); values.push(input.tokenType) }
    if (input.expiresAt !== undefined) { fields.push('oauth_expires_at = ?'); values.push(input.expiresAt) }
    if (input.idToken !== undefined) { fields.push('oauth_id_token = ?'); values.push(input.idToken) }
    if (input.metadataJson !== undefined) { fields.push('oauth_metadata_json = ?'); values.push(input.metadataJson) }
    if (input.registrationJson !== undefined) { fields.push('oauth_registration_json = ?'); values.push(input.registrationJson) }
    if (input.authState !== undefined) { fields.push('oauth_auth_state = ?'); values.push(input.authState) }
    if (input.redirectMode !== undefined) { fields.push('oauth_redirect_mode = ?'); values.push(input.redirectMode) }
    if (input.lastError !== undefined) { fields.push('oauth_last_error = ?'); values.push(input.lastError) }
    if (input.connectedAt !== undefined) { fields.push('oauth_connected_at = ?'); values.push(input.connectedAt) }

    if (fields.length === 0) return current

    fields.push("updated_at = datetime('now')")
    values.push(id)

    this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.findById(id)!
  }

  updateOAuthRegistration(id: string, input: UpdateMcpOAuthRegistrationInput): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    const fields: string[] = []
    const values: unknown[] = []

    if (input.clientId !== undefined) { fields.push('oauth_client_id = ?'); values.push(input.clientId) }
    if (input.registrationJson !== undefined) { fields.push('oauth_registration_json = ?'); values.push(input.registrationJson) }
    if (input.redirectMode !== undefined) { fields.push('oauth_redirect_mode = ?'); values.push(input.redirectMode) }

    if (fields.length === 0) return current

    fields.push("updated_at = datetime('now')")
    values.push(id)

    this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.findById(id)!
  }

  clearOAuthSession(id: string): McpServer {
    const current = this.findById(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    this.db.prepare(`
      UPDATE mcp_servers
      SET
        oauth_access_token = NULL,
        oauth_refresh_token = NULL,
        oauth_token_type = NULL,
        oauth_expires_at = NULL,
        oauth_id_token = NULL,
        oauth_last_error = NULL,
        oauth_connected_at = NULL,
        oauth_auth_state = CASE
          WHEN oauth_metadata_json IS NOT NULL OR oauth_registration_json IS NOT NULL OR oauth_client_id IS NOT NULL
            THEN 'required'
          ELSE oauth_auth_state
        END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(id)

    return this.findById(id)!
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
  }
}
