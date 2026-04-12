import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Repo {
  id: string
  name: string
  alias: string | null
  local_path: string
  default_branch: string
  agent_provider: string | null
  created_at: string
}

export interface CreateRepoInput {
  name: string
  alias?: string
  local_path: string
  default_branch: string
  agent_provider?: string
}

export interface UpdateRepoInput {
  name?: string
  alias?: string | null
  default_branch?: string
}

export class RepoRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRepoInput): Repo {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO repos (id, name, alias, local_path, default_branch, agent_provider)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.alias ?? null, input.local_path, input.default_branch, input.agent_provider ?? null)
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

  update(id: string, input: UpdateRepoInput): Repo {
    const sets: string[] = []
    const values: unknown[] = []
    if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name) }
    if (input.alias !== undefined) { sets.push('alias = ?'); values.push(input.alias) }
    if (input.default_branch !== undefined) { sets.push('default_branch = ?'); values.push(input.default_branch) }
    if (sets.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.findById(id)!
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id)
  }
}
