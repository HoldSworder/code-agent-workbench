import type Database from 'better-sqlite3'

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL DEFAULT 'main',
      agent_provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT,
      doc_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS repo_tasks (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(id),
      repo_id TEXT NOT NULL REFERENCES repos(id),
      branch_name TEXT NOT NULL,
      change_id TEXT NOT NULL,
      current_stage TEXT NOT NULL DEFAULT 'planning',
      current_phase TEXT NOT NULL DEFAULT 'task-breakdown',
      phase_status TEXT NOT NULL DEFAULT 'running',
      openspec_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      repo_task_id TEXT NOT NULL REFERENCES repo_tasks(id),
      phase_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      token_usage INTEGER,
      error TEXT,
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      repo_task_id TEXT NOT NULL REFERENCES repo_tasks(id),
      phase_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS phase_commits (
      repo_task_id TEXT NOT NULL REFERENCES repo_tasks(id),
      phase_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo_task_id, phase_id)
    );

    CREATE INDEX IF NOT EXISTS idx_repo_tasks_requirement ON repo_tasks(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_repo_tasks_repo ON repo_tasks(repo_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(repo_task_id);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON conversation_messages(repo_task_id);

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      transport   TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
      command     TEXT,
      args        TEXT NOT NULL DEFAULT '[]',
      env         TEXT NOT NULL DEFAULT '{}',
      url         TEXT,
      headers     TEXT NOT NULL DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS phase_mcp_bindings (
      id            TEXT PRIMARY KEY,
      stage_id      TEXT NOT NULL,
      phase_id      TEXT NOT NULL,
      mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(stage_id, phase_id, mcp_server_id)
    );

    CREATE INDEX IF NOT EXISTS idx_phase_mcp_bindings_phase ON phase_mcp_bindings(stage_id, phase_id);
    CREATE INDEX IF NOT EXISTS idx_phase_mcp_bindings_server ON phase_mcp_bindings(mcp_server_id);
  `)

  // Migrations: add doc_url column to requirements for existing DBs
  const reqCols = db.prepare(`PRAGMA table_info(requirements)`).all() as { name: string }[]
  if (!reqCols.some(c => c.name === 'doc_url')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN doc_url TEXT`)
  }

  // Migrations: add current_stage column to repo_tasks for existing DBs
  const taskCols = db.prepare(`PRAGMA table_info(repo_tasks)`).all() as { name: string }[]
  if (!taskCols.some(c => c.name === 'current_stage')) {
    db.exec(`ALTER TABLE repo_tasks ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'requirements'`)
  }

  // Migrations: add missing columns to agent_runs for existing DBs
  const cols = db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]
  if (!cols.some(c => c.name === 'session_id')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN session_id TEXT`)
  }
  if (!cols.some(c => c.name === 'model')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN model TEXT`)
  }
}
