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

  describe('Feishu Project MCP quick config', () => {
    it('upsertFeishuProject inserts with fixed id and auto-flags it', () => {
      const upserted = repo.upsertFeishuProject({
        url: 'https://project.feishu.cn/openapi/mcp',
        headers: { 'X-Tenant': 'wuhan' },
      })
      expect(upserted.id).toBe('feishu-project')
      expect(upserted.transport).toBe('http')
      expect(upserted.is_feishu_project).toBe(1)
      expect(upserted.url).toBe('https://project.feishu.cn/openapi/mcp')
      expect(JSON.parse(upserted.headers)).toEqual({ 'X-Tenant': 'wuhan' })

      const flagged = repo.findFeishuProject()
      expect(flagged?.id).toBe('feishu-project')
    })

    it('upsertFeishuProject updates existing flagged row in place (preserves id)', () => {
      const original = repo.create({
        name: 'lark-project',
        transport: 'http',
        url: 'https://old.example.com/mcp',
      })
      repo.setFeishuProject(original.id)

      const updated = repo.upsertFeishuProject({
        url: 'https://new.example.com/mcp',
        headers: { Authorization: 'Bearer xyz' },
        description: '已更新描述',
      })

      expect(updated.id).toBe(original.id)
      expect(updated.url).toBe('https://new.example.com/mcp')
      expect(updated.description).toBe('已更新描述')
      expect(updated.is_feishu_project).toBe(1)
      expect(JSON.parse(updated.headers)).toEqual({ Authorization: 'Bearer xyz' })

      // 仍然只有一条标记位
      const allFlagged = db.prepare('SELECT id FROM mcp_servers WHERE is_feishu_project = 1').all() as Array<{ id: string }>
      expect(allFlagged).toHaveLength(1)
      expect(allFlagged[0].id).toBe(original.id)
    })

    it('upsertFeishuProject clears stale flags on other rows when inserting', () => {
      const orphan = repo.create({
        name: 'orphan-http',
        transport: 'http',
        url: 'https://orphan.example.com/mcp',
      })
      // 直接绕开 setFeishuProject 制造一条"残留"标记位（模拟历史脏数据）
      db.prepare('UPDATE mcp_servers SET is_feishu_project = 1 WHERE id = ?').run(orphan.id)
      // 再删除其 flag 但保留它（不影响 insert path）
      db.prepare('UPDATE mcp_servers SET is_feishu_project = 0 WHERE id = ?').run(orphan.id)

      // 插入新固定 id 行；同时手动注入一条假"残留"
      db.prepare(`
        INSERT INTO mcp_servers (id, name, transport, url, is_feishu_project)
        VALUES ('legacy-other', 'legacy-other', 'http', 'https://legacy.example.com/mcp', 1)
      `).run()

      const upserted = repo.upsertFeishuProject({
        url: 'https://project.feishu.cn/openapi/mcp',
      })
      // 因为已有 is_feishu_project=1 行（legacy-other），upsert 走 update 分支，不会用固定 id
      expect(upserted.id).toBe('legacy-other')
      const flaggedRows = db.prepare('SELECT id FROM mcp_servers WHERE is_feishu_project = 1').all() as Array<{ id: string }>
      expect(flaggedRows).toHaveLength(1)
    })

    it('deleteFeishuProject removes the flagged row and reports', () => {
      repo.upsertFeishuProject({ url: 'https://x.com/mcp' })
      const result = repo.deleteFeishuProject()
      expect(result.deleted).toBe(true)
      expect(result.id).toBe('feishu-project')
      expect(repo.findFeishuProject()).toBeNull()
      expect(repo.findById('feishu-project')).toBeUndefined()

      const second = repo.deleteFeishuProject()
      expect(second.deleted).toBe(false)
      expect(second.id).toBeNull()
    })

    it('migrateLegacyLarkProject auto-flags legacy lark-project row', () => {
      const legacy = repo.create({
        name: 'lark-project',
        transport: 'http',
        url: 'https://legacy.example.com/mcp',
      })
      expect(legacy.is_feishu_project).toBe(0)

      const result = repo.migrateLegacyLarkProject()
      expect(result.migrated).toBe(true)
      expect(result.id).toBe(legacy.id)
      expect(repo.findFeishuProject()?.id).toBe(legacy.id)
    })

    it('migrateLegacyLarkProject is noop when already flagged', () => {
      const a = repo.create({ name: 'lark-project', transport: 'http', url: 'https://a/mcp' })
      repo.setFeishuProject(a.id)
      const result = repo.migrateLegacyLarkProject()
      expect(result.migrated).toBe(false)
      expect(result.id).toBe(a.id)
    })

    it('migrateLegacyLarkProject is noop when no legacy row exists', () => {
      repo.create({ name: 'unrelated', transport: 'http', url: 'https://unrelated/mcp' })
      const result = repo.migrateLegacyLarkProject()
      expect(result.migrated).toBe(false)
      expect(result.id).toBeNull()
    })
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
