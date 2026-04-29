import type Database from 'better-sqlite3'

export type Role = 'frontend' | 'backend' | 'qa'

export interface AssessmentRow {
  session_id: string
  role: Role
  points: number
  rationale: string
  assessor_user_id: string
  created_at: string
}

export interface SaveAssessmentInput {
  sessionId: string
  role: Role
  points: number
  rationale: string
  assessorUserId: string
}

export class AssessmentRepository {
  constructor(private db: Database.Database) {}

  save(input: SaveAssessmentInput): void {
    this.db.prepare(`
      INSERT INTO review_assessments (session_id, role, points, rationale, assessor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(session_id, role) DO UPDATE SET
        points = excluded.points,
        rationale = excluded.rationale,
        assessor_user_id = excluded.assessor_user_id,
        created_at = datetime('now')
    `).run(input.sessionId, input.role, input.points, input.rationale, input.assessorUserId)
  }

  listBySession(sessionId: string): AssessmentRow[] {
    return this.db
      .prepare(`SELECT * FROM review_assessments WHERE session_id = ? ORDER BY role`)
      .all(sessionId) as AssessmentRow[]
  }
}
