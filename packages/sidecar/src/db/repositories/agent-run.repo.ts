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

  findByTaskId(repoTaskId: string): AgentRun[] {
    return this.db
      .prepare('SELECT * FROM agent_runs WHERE repo_task_id = ? ORDER BY started_at ASC')
      .all(repoTaskId) as AgentRun[]
  }

  finish(
    id: string,
    status: string,
    tokenUsage?: number,
    error?: string,
  ): void {
    this.db
      .prepare(
        `
      UPDATE agent_runs
      SET status = ?,
          finished_at = datetime('now'),
          token_usage = ?,
          error = ?
      WHERE id = ?
    `,
      )
      .run(status, tokenUsage ?? null, error ?? null, id)
  }
}
