import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { McpServer } from './mcp-server.repo'

export interface McpBinding {
  id: string
  stage_id: string
  phase_id: string
  mcp_server_id: string
  created_at: string
}

export class McpBindingRepository {
  constructor(private db: Database.Database) {}

  findByPhase(stageId: string, phaseId: string): McpBinding[] {
    return this.db.prepare(
      'SELECT * FROM phase_mcp_bindings WHERE stage_id = ? AND phase_id = ? ORDER BY created_at ASC',
    ).all(stageId, phaseId) as McpBinding[]
  }

  findAll(): McpBinding[] {
    return this.db.prepare('SELECT * FROM phase_mcp_bindings ORDER BY stage_id, phase_id, created_at ASC').all() as McpBinding[]
  }

  hasBindings(stageId: string, phaseId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM phase_mcp_bindings WHERE stage_id = ? AND phase_id = ? LIMIT 1',
    ).get(stageId, phaseId)
    return !!row
  }

  setBindings(stageId: string, phaseId: string, mcpServerIds: string[]): void {
    const deleteStmt = this.db.prepare(
      'DELETE FROM phase_mcp_bindings WHERE stage_id = ? AND phase_id = ?',
    )
    const insertStmt = this.db.prepare(
      'INSERT INTO phase_mcp_bindings (id, stage_id, phase_id, mcp_server_id) VALUES (?, ?, ?, ?)',
    )

    const tx = this.db.transaction(() => {
      deleteStmt.run(stageId, phaseId)
      for (const serverId of mcpServerIds) {
        insertStmt.run(randomUUID(), stageId, phaseId, serverId)
      }
    })
    tx()
  }

  resolveServersForPhase(stageId: string, phaseId: string): McpServer[] {
    return this.db.prepare(`
      SELECT s.* FROM mcp_servers s
      INNER JOIN phase_mcp_bindings b ON b.mcp_server_id = s.id
      WHERE b.stage_id = ? AND b.phase_id = ? AND s.enabled = 1
      ORDER BY s.name ASC
    `).all(stageId, phaseId) as McpServer[]
  }

  deleteByServer(mcpServerId: string): void {
    this.db.prepare('DELETE FROM phase_mcp_bindings WHERE mcp_server_id = ?').run(mcpServerId)
  }
}
