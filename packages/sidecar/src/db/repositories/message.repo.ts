import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface Message {
  id: string
  repo_task_id: string
  phase_id: string
  role: string
  content: string
  created_at: string
}

export interface CreateMessageInput {
  repo_task_id: string
  phase_id: string
  role: string
  content: string
}

export class MessageRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateMessageInput): Message {
    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO conversation_messages (id, repo_task_id, phase_id, role, content)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id, input.repo_task_id, input.phase_id, input.role, input.content)
    return this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id) as Message
  }

  deleteByTask(taskId: string): void {
    this.db.prepare('DELETE FROM conversation_messages WHERE repo_task_id = ?').run(taskId)
  }

  deleteByTaskAndPhases(taskId: string, phaseIds: string[]): void {
    if (!phaseIds.length) return
    const placeholders = phaseIds.map(() => '?').join(',')
    this.db.prepare(
      `DELETE FROM conversation_messages WHERE repo_task_id = ? AND phase_id IN (${placeholders})`,
    ).run(taskId, ...phaseIds)
  }

  findByTaskAndPhase(taskId: string, phaseId: string): Message[] {
    return this.db
      .prepare(
        `
      SELECT * FROM conversation_messages
      WHERE repo_task_id = ? AND phase_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(taskId, phaseId) as Message[]
  }

  findById(id: string): Message | undefined {
    return this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id) as Message | undefined
  }

  deleteAfterMessage(taskId: string, phaseId: string, afterCreatedAt: string): void {
    this.db.prepare(
      `DELETE FROM conversation_messages WHERE repo_task_id = ? AND phase_id = ? AND created_at > ?`,
    ).run(taskId, phaseId, afterCreatedAt)
  }

  findByTask(taskId: string): Message[] {
    return this.db
      .prepare(
        `
      SELECT * FROM conversation_messages
      WHERE repo_task_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(taskId) as Message[]
  }
}
