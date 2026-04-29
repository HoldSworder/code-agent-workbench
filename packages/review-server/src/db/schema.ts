import type Database from 'better-sqlite3'

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_sessions (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      requirement_title TEXT NOT NULL DEFAULT '',
      feishu_requirement_url TEXT,
      feishu_spec_doc_token TEXT,
      feishu_spec_doc_url TEXT,
      related_repos TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      host_user_id TEXT NOT NULL,
      host_user_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT,
      closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_review_sessions_requirement
      ON review_sessions(requirement_id);

    CREATE TABLE IF NOT EXISTS review_spec_cache (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS review_clarifications (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_review_clarifications_session
      ON review_clarifications(session_id);

    CREATE TABLE IF NOT EXISTS review_assessments (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('frontend', 'backend', 'qa')),
      points REAL NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      assessor_user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, role)
    );
  `)
}
