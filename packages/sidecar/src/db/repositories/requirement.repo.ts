import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Requirement {
  id: string
  title: string
  description: string
  source: string
  source_url: string | null
  doc_url: string | null
  fetch_error: string | null
  fetch_output: string | null
  fetch_prompt: string | null
  fetch_cli_type: string | null
  fetch_model: string | null
  status: string
  mode: string
  created_at: string
}

export interface CreateRequirementInput {
  title?: string
  description: string
  source: string
  source_url?: string
  doc_url?: string
  mode?: string
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
        `INSERT INTO requirements (id, title, description, source, source_url, doc_url, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, input.description, input.source, input.source_url ?? null, input.doc_url ?? null, input.mode ?? 'workflow')
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

  update(id: string, data: { title?: string, description?: string, doc_url?: string | null, mode?: string }): void {
    const sets: string[] = []
    const values: (string | null)[] = []
    if (data.title !== undefined) { sets.push('title = ?'); values.push(data.title) }
    if (data.description !== undefined) { sets.push('description = ?'); values.push(data.description) }
    if (data.doc_url !== undefined) { sets.push('doc_url = ?'); values.push(data.doc_url) }
    if (data.mode !== undefined) { sets.push('mode = ?'); values.push(data.mode) }
    if (sets.length === 0) return
    values.push(id)
    this.db.prepare(`UPDATE requirements SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE requirements SET status = ? WHERE id = ?').run(status, id)
  }

  updateFetchError(id: string, error: string | null): void {
    this.db.prepare('UPDATE requirements SET fetch_error = ? WHERE id = ?').run(error, id)
  }

  updateFetchOutput(id: string, output: string | null): void {
    this.db.prepare('UPDATE requirements SET fetch_output = ? WHERE id = ?').run(output, id)
  }

  updateFetchMeta(id: string, meta: { prompt?: string | null, cliType?: string | null, model?: string | null }): void {
    if (meta.prompt !== undefined)
      this.db.prepare('UPDATE requirements SET fetch_prompt = ? WHERE id = ?').run(meta.prompt, id)
    if (meta.cliType !== undefined)
      this.db.prepare('UPDATE requirements SET fetch_cli_type = ? WHERE id = ?').run(meta.cliType, id)
    if (meta.model !== undefined)
      this.db.prepare('UPDATE requirements SET fetch_model = ? WHERE id = ?').run(meta.model, id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM requirements WHERE id = ?').run(id)
  }
}
