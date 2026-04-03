import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Requirement {
  id: string
  title: string
  description: string
  source: string
  source_url: string | null
  status: string
  created_at: string
}

export interface CreateRequirementInput {
  title: string
  description: string
  source: string
  source_url?: string
}

export class RequirementRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRequirementInput): Requirement {
    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO requirements (id, title, description, source, source_url)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id, input.title, input.description, input.source, input.source_url ?? null)
    return this.findById(id)!
  }

  findById(id: string): Requirement | undefined {
    return this.db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as
      | Requirement
      | undefined
  }

  findAll(): Requirement[] {
    return this.db
      .prepare('SELECT * FROM requirements ORDER BY created_at DESC')
      .all() as Requirement[]
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE requirements SET status = ? WHERE id = ?').run(status, id)
  }
}
