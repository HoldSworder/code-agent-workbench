import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface AgentRun {
  id: string
  repo_task_id: string
  phase_id: string
  provider: string
  status: string
  started_at: string
  finished_at: string | null
  token_usage: number | null
  error: string | null
  session_id: string | null
  model: string | null
}

export interface CreateAgentRunInput {
  repo_task_id: string
  phase_id: string
  provider: string
}

export class AgentRunRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateAgentRunInput): AgentRun {
    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO agent_runs (id, repo_task_id, phase_id, provider)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(id, input.repo_task_id, input.phase_id, input.provider)
    return this.findById(id)!
  }

  findById(id: string): AgentRun | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRun | undefined
  }

  findLastByTask(repoTaskId: string): AgentRun | undefined {
    return this.db
      .prepare('SELECT * FROM agent_runs WHERE repo_task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(repoTaskId) as AgentRun | undefined
  }

  deleteByTask(repoTaskId: string): void {
    this.db.prepare('DELETE FROM agent_runs WHERE repo_task_id = ?').run(repoTaskId)
  }

  deleteByTaskAndPhases(repoTaskId: string, phaseIds: string[]): void {
    if (!phaseIds.length) return
    const placeholders = phaseIds.map(() => '?').join(',')
    this.db.prepare(
      `DELETE FROM agent_runs WHERE repo_task_id = ? AND phase_id IN (${placeholders})`,
    ).run(repoTaskId, ...phaseIds)
  }

  deleteByTaskPhaseAfterTime(repoTaskId: string, phaseId: string, afterTime: string): void {
    this.db.prepare(
      `DELETE FROM agent_runs WHERE repo_task_id = ? AND phase_id = ? AND started_at > ?`,
    ).run(repoTaskId, phaseId, afterTime)
  }

  findByTaskId(repoTaskId: string): AgentRun[] {
    return this.db
      .prepare('SELECT * FROM agent_runs WHERE repo_task_id = ? ORDER BY started_at DESC')
      .all(repoTaskId) as AgentRun[]
  }

  finish(
    id: string,
    status: string,
    tokenUsage?: number,
    error?: string,
    sessionId?: string,
    model?: string,
  ): void {
    this.db
      .prepare(
        `
      UPDATE agent_runs
      SET status = ?,
          finished_at = datetime('now'),
          token_usage = ?,
          error = ?,
          session_id = ?,
          model = ?
      WHERE id = ?
    `,
      )
      .run(status, tokenUsage ?? null, error ?? null, sessionId ?? null, model ?? null, id)
  }

  findLastSessionId(repoTaskId: string, phaseId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT session_id, status FROM agent_runs
         WHERE repo_task_id = ? AND phase_id = ? AND session_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(repoTaskId, phaseId) as { session_id: string, status: string } | undefined
    if (!row || row.status !== 'success') return null
    return row.session_id
  }
}
