import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Requirement {
  id: string
  title: string
  description: string
  source: string
  source_url: string | null
  doc_url: string | null
  status: string
  created_at: string
}

export interface CreateRequirementInput {
  title?: string
  description: string
  source: string
  source_url?: string
  doc_url?: string
}

function autoTitle(description: string): string {
  const firstLine = description.split('\n')[0].trim()
  if (!firstLine) return '未命名需求'
  return firstLine.length <= 50 ? firstLine : `${firstLine.slice(0, 50)}...`
}

export class RequirementRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRequirementInput): Requirement {
    const id = randomUUID()
    const title = input.title?.trim() || autoTitle(input.description)
    this.db
      .prepare(
        `INSERT INTO requirements (id, title, description, source, source_url, doc_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, input.description, input.source, input.source_url ?? null, input.doc_url ?? null)
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

  delete(id: string): void {
    this.db.prepare('DELETE FROM requirements WHERE id = ?').run(id)
  }
}
