import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  FEISHU_PROJECT_MCP_ID,
  FEISHU_PROJECT_MCP_DEFAULT_NAME,
  FEISHU_PROJECT_MCP_LEGACY_NAME,
} from '../../review/feishu-mcp-id'

export interface UpsertFeishuProjectInput {
  url: string
  headers?: Record<string, string>
  name?: string
  description?: string
  enabled?: boolean
}

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
  is_feishu_project: number
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

  /**
   * 把指定 MCP 标记为"全局飞书项目 MCP"。事务保证全局唯一。
   */
  setFeishuProject(id: string): McpServer {
    const target = this.findById(id)
    if (!target) throw new Error(`MCP server not found: ${id}`)
    if (target.transport !== 'http') throw new Error('仅 transport=http 的 MCP 可标记为飞书项目 MCP')

    this.db.transaction(() => {
      this.db.prepare("UPDATE mcp_servers SET is_feishu_project = 0, updated_at = datetime('now') WHERE is_feishu_project = 1").run()
      this.db.prepare("UPDATE mcp_servers SET is_feishu_project = 1, updated_at = datetime('now') WHERE id = ?").run(id)
    })()

    return this.findById(id)!
  }

  /**
   * 取消"全局飞书项目 MCP"标记（任意时刻最多 1 条，因此不需要参数）。
   */
  unsetFeishuProject(): void {
    this.db.prepare("UPDATE mcp_servers SET is_feishu_project = 0, updated_at = datetime('now') WHERE is_feishu_project = 1").run()
  }

  findFeishuProject(): McpServer | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE is_feishu_project = 1 LIMIT 1').get() as McpServer | undefined
    return row ?? null
  }

  /**
   * 飞书项目 MCP 快捷配置：
   * - 已存在 is_feishu_project=1 记录 → 在该行上更新 url/headers/enabled/(name/description 可选)
   * - 不存在 → 以固定 id `FEISHU_PROJECT_MCP_ID` 插入新行（transport=http, is_feishu_project=1）
   * 全程在事务内执行；返回最新行。
   */
  upsertFeishuProject(input: UpsertFeishuProjectInput): McpServer {
    if (!input.url || typeof input.url !== 'string')
      throw new Error('飞书项目 MCP 必须提供 URL')

    const headersJson = JSON.stringify(input.headers ?? {})
    const enabledNum = input.enabled === false ? 0 : 1

    const tx = this.db.transaction(() => {
      const existing = this.findFeishuProject()
      if (existing) {
        const fields: string[] = ['url = ?', 'headers = ?', 'enabled = ?', 'transport = ?']
        const values: unknown[] = [input.url, headersJson, enabledNum, 'http']
        if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name) }
        if (input.description !== undefined) { fields.push('description = ?'); values.push(input.description) }
        fields.push("updated_at = datetime('now')")
        values.push(existing.id)
        this.db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
        return existing.id
      }

      // 不存在标记位记录：尝试用固定 id 插入；若 id 已被占用（极少见），回退 randomUUID
      const collision = this.findById(FEISHU_PROJECT_MCP_ID)
      const insertId = collision ? randomUUID() : FEISHU_PROJECT_MCP_ID

      this.db.prepare(`
        INSERT INTO mcp_servers (
          id, name, description, transport, command, args, env, url, headers, enabled, is_feishu_project
        )
        VALUES (?, ?, ?, 'http', NULL, '[]', '{}', ?, ?, ?, 1)
      `).run(
        insertId,
        input.name ?? FEISHU_PROJECT_MCP_DEFAULT_NAME,
        input.description ?? '',
        input.url,
        headersJson,
        enabledNum,
      )
      // 保证全局唯一标记（顺手清掉其他可能残留的标记位）
      this.db.prepare(
        "UPDATE mcp_servers SET is_feishu_project = 0, updated_at = datetime('now') WHERE is_feishu_project = 1 AND id != ?",
      ).run(insertId)
      return insertId
    })

    const id = tx()
    return this.findById(id)!
  }

  /**
   * 删除飞书项目 MCP（快捷卡片"清除"）：
   * 优先按 is_feishu_project=1 找；找不到再按固定 id 找；都没有则 noop。
   */
  deleteFeishuProject(): { deleted: boolean, id: string | null } {
    const target = this.findFeishuProject() ?? this.findById(FEISHU_PROJECT_MCP_ID) ?? null
    if (!target) return { deleted: false, id: null }
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(target.id)
    return { deleted: true, id: target.id }
  }

  /**
   * 一次性迁移：兼容历史 v1 通过 `findByName('lark-project')` 定位的实现。
   * - 若已有任意 is_feishu_project=1 记录 → noop
   * - 否则若存在 name='lark-project' 且 transport='http' 的记录 → 给它置 is_feishu_project=1
   * - 否则 → noop（保持"未配置"，由用户在快捷卡片里填）
   */
  migrateLegacyLarkProject(): { migrated: boolean, id: string | null } {
    const flagged = this.findFeishuProject()
    if (flagged) return { migrated: false, id: flagged.id }

    const legacy = this.db.prepare(
      'SELECT * FROM mcp_servers WHERE name = ? AND transport = ? LIMIT 1',
    ).get(FEISHU_PROJECT_MCP_LEGACY_NAME, 'http') as McpServer | undefined

    if (!legacy) return { migrated: false, id: null }

    this.db.prepare(
      "UPDATE mcp_servers SET is_feishu_project = 1, updated_at = datetime('now') WHERE id = ?",
    ).run(legacy.id)
    return { migrated: true, id: legacy.id }
  }
}
