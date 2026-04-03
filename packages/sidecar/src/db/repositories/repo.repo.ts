import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Repo {
  id: string
  name: string
  local_path: string
  default_branch: string
  agent_provider: string | null
  created_at: string
}

export interface CreateRepoInput {
  name: string
  local_path: string
  default_branch: string
  agent_provider?: string
}

export class RepoRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRepoInput): Repo {
    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO repos (id, name, local_path, default_branch, agent_provider)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id, input.name, input.local_path, input.default_branch, input.agent_provider ?? null)
    return this.findById(id)!
  }

  findById(id: string): Repo | undefined {
    return this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as Repo | undefined
  }

  findAll(): Repo[] {
    return this.db
      .prepare('SELECT * FROM repos ORDER BY created_at DESC, rowid DESC')
      .all() as Repo[]
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id)
  }
}
