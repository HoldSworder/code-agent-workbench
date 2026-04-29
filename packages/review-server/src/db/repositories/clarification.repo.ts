import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface ClarificationRow {
  id: string
  session_id: string
  user_id: string
  user_name: string
  content: string
  parent_id: string | null
  created_at: string
}

export interface AddClarificationInput {
  sessionId: string
  userId: string
  userName: string
  content: string
  parentId?: string
}

export class ClarificationRepository {
  constructor(private db: Database.Database) {}

  add(input: AddClarificationInput): ClarificationRow {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO review_clarifications (id, session_id, user_id, user_name, content, parent_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.userId, input.userName, input.content, input.parentId ?? null)
    return this.db.prepare(`SELECT * FROM review_clarifications WHERE id = ?`).get(id) as ClarificationRow
  }

  listBySession(sessionId: string): ClarificationRow[] {
    return this.db
      .prepare(`SELECT * FROM review_clarifications WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as ClarificationRow[]
  }
}
