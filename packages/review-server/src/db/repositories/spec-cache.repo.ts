import type Database from 'better-sqlite3'

export interface SpecCacheRow {
  session_id: string
  content: string
  version: number
  updated_at: string
}

export class SpecCacheRepository {
  constructor(private db: Database.Database) {}

  get(sessionId: string): SpecCacheRow | null {
    return (this.db.prepare(`SELECT * FROM review_spec_cache WHERE session_id = ?`).get(sessionId) as SpecCacheRow | undefined) ?? null
  }

  upsert(sessionId: string, content: string, version: number): void {
    this.db.prepare(`
      INSERT INTO review_spec_cache (session_id, content, version, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        content = excluded.content,
        version = excluded.version,
        updated_at = datetime('now')
    `).run(sessionId, content, version)
  }
}
