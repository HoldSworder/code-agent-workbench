import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface ReviewSessionRow {
  id: string
  requirement_id: string
  requirement_title: string
  feishu_requirement_url: string | null
  feishu_spec_doc_token: string | null
  feishu_spec_doc_url: string | null
  related_repos: string
  status: 'open' | 'confirmed' | 'closed'
  host_user_id: string
  host_user_name: string
  created_at: string
  confirmed_at: string | null
  closed_at: string | null
}

export interface CreateSessionInput {
  requirementId: string
  requirementTitle: string
  feishuRequirementUrl?: string | null
  feishuSpecDocToken?: string | null
  feishuSpecDocUrl?: string | null
  relatedRepos: string[]
  hostUserId: string
  hostUserName: string
}

export class SessionRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateSessionInput): ReviewSessionRow {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO review_sessions (
        id, requirement_id, requirement_title, feishu_requirement_url,
        feishu_spec_doc_token, feishu_spec_doc_url,
        related_repos, host_user_id, host_user_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.requirementId,
      input.requirementTitle,
      input.feishuRequirementUrl ?? null,
      input.feishuSpecDocToken ?? null,
      input.feishuSpecDocUrl ?? null,
      JSON.stringify(input.relatedRepos),
      input.hostUserId,
      input.hostUserName,
    )
    return this.findById(id)!
  }

  findById(id: string): ReviewSessionRow | null {
    return (this.db.prepare(`SELECT * FROM review_sessions WHERE id = ?`).get(id) as ReviewSessionRow | undefined) ?? null
  }

  findByRequirementId(requirementId: string): ReviewSessionRow | null {
    return (this.db.prepare(
      `SELECT * FROM review_sessions WHERE requirement_id = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
    ).get(requirementId) as ReviewSessionRow | undefined) ?? null
  }

  list(): ReviewSessionRow[] {
    return this.db.prepare(`SELECT * FROM review_sessions ORDER BY created_at DESC`).all() as ReviewSessionRow[]
  }

  updateStatus(id: string, status: ReviewSessionRow['status']): void {
    if (status === 'confirmed') {
      this.db.prepare(`UPDATE review_sessions SET status = ?, confirmed_at = datetime('now') WHERE id = ?`)
        .run(status, id)
    }
    else if (status === 'closed') {
      this.db.prepare(`UPDATE review_sessions SET status = ?, closed_at = datetime('now') WHERE id = ?`)
        .run(status, id)
    }
    else {
      this.db.prepare(`UPDATE review_sessions SET status = ? WHERE id = ?`).run(status, id)
    }
  }
}
