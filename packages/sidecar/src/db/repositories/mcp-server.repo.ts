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
  created_at: string
  updated_at: string
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
}

export class McpServerRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateMcpServerInput): McpServer {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO mcp_servers (id, name, description, transport, command, args, env, url, headers, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  delete(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
  }
}
