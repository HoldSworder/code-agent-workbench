import type Database from 'better-sqlite3'

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      alias TEXT,
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
      phase_status TEXT NOT NULL DEFAULT 'pending',
      openspec_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      workflow_id TEXT,
      workflow_completed INTEGER NOT NULL DEFAULT 0,
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
      last_test_status TEXT CHECK (last_test_status IN ('success', 'error')),
      last_test_error TEXT,
      last_tested_at TEXT,
      capabilities_json TEXT,
      capabilities_summary TEXT,
      auth_type TEXT CHECK (auth_type IN ('oauth')),
      oauth_client_id TEXT,
      oauth_scope TEXT,
      oauth_audience TEXT,
      oauth_token_endpoint_auth_method TEXT,
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_token_type TEXT,
      oauth_expires_at TEXT,
      oauth_id_token TEXT,
      oauth_metadata_json TEXT,
      oauth_registration_json TEXT,
      oauth_auth_state TEXT CHECK (oauth_auth_state IN ('none', 'required', 'connected', 'unsupported', 'error')),
      oauth_redirect_mode TEXT CHECK (oauth_redirect_mode IN ('deeplink', 'loopback')),
      oauth_last_error TEXT,
      oauth_connected_at TEXT,
      is_feishu_project INTEGER NOT NULL DEFAULT 0,
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

    -- Orchestrator tables (multi-agent orchestration, independent from WorkflowEngine)

    CREATE TABLE IF NOT EXISTS orchestrator_runs (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(id),
      team_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      leader_decision TEXT,
      reject_feedback TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES orchestrator_runs(id),
      role TEXT NOT NULL,
      repo_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      agent_provider TEXT,
      agent_model TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS orchestrator_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES orchestrator_runs(id),
      assignment_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_requirement ON orchestrator_runs(requirement_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_run ON assignments(run_id);
    CREATE INDEX IF NOT EXISTS idx_orchestrator_events_run ON orchestrator_events(run_id);

    CREATE TABLE IF NOT EXISTS activated_phases (
      repo_task_id TEXT NOT NULL REFERENCES repo_tasks(id),
      phase_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo_task_id, phase_id)
    );
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

  const taskCols2 = db.prepare(`PRAGMA table_info(repo_tasks)`).all() as { name: string }[]
  if (!taskCols2.some(c => c.name === 'workflow_id')) {
    db.exec(`ALTER TABLE repo_tasks ADD COLUMN workflow_id TEXT`)
  }

  // Migration: add mode column to requirements for orchestrator support
  const reqCols2 = db.prepare(`PRAGMA table_info(requirements)`).all() as { name: string }[]
  if (!reqCols2.some(c => c.name === 'mode')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN mode TEXT NOT NULL DEFAULT 'workflow'`)
  }

  // Migration: add fetch_error / fetch_output columns to requirements for feishu auto-fetch
  const reqCols3 = db.prepare(`PRAGMA table_info(requirements)`).all() as { name: string }[]
  if (!reqCols3.some(c => c.name === 'fetch_error')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN fetch_error TEXT`)
  }
  if (!reqCols3.some(c => c.name === 'fetch_output')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN fetch_output TEXT`)
  }

  // Migration: add fetch_prompt / fetch_cli_type / fetch_model columns to requirements
  const reqCols4 = db.prepare(`PRAGMA table_info(requirements)`).all() as { name: string }[]
  if (!reqCols4.some(c => c.name === 'fetch_prompt')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN fetch_prompt TEXT`)
  }
  if (!reqCols4.some(c => c.name === 'fetch_cli_type')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN fetch_cli_type TEXT`)
  }
  if (!reqCols4.some(c => c.name === 'fetch_model')) {
    db.exec(`ALTER TABLE requirements ADD COLUMN fetch_model TEXT`)
  }

  // Migration: add alias column to repos
  const repoCols = db.prepare(`PRAGMA table_info(repos)`).all() as { name: string }[]
  if (!repoCols.some(c => c.name === 'alias')) {
    db.exec(`ALTER TABLE repos ADD COLUMN alias TEXT`)
  }

  // Fix stale default: old schema created tables with phase_status DEFAULT 'running'.
  // SQLite cannot ALTER column defaults, so we rebuild the table with correct defaults.
  // Wrapped in a transaction to avoid partial state on interruption.
  const dfltCheck = db.prepare(
    `SELECT dflt_value FROM pragma_table_info('repo_tasks') WHERE name = 'phase_status'`,
  ).get() as { dflt_value: string | null } | undefined
  if (dfltCheck && dfltCheck.dflt_value !== null && dfltCheck.dflt_value !== `'pending'`) {
    db.pragma('foreign_keys = OFF')
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS repo_tasks_new`)
      db.exec(`
        CREATE TABLE repo_tasks_new (
          id TEXT PRIMARY KEY,
          requirement_id TEXT NOT NULL REFERENCES requirements(id),
          repo_id TEXT NOT NULL REFERENCES repos(id),
          branch_name TEXT NOT NULL,
          change_id TEXT NOT NULL,
          current_stage TEXT NOT NULL DEFAULT 'planning',
          current_phase TEXT NOT NULL DEFAULT 'task-breakdown',
          phase_status TEXT NOT NULL DEFAULT 'pending',
          openspec_path TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          workflow_id TEXT,
          workflow_completed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO repo_tasks_new SELECT
          id, requirement_id, repo_id, branch_name, change_id,
          current_stage, current_phase, phase_status,
          openspec_path, worktree_path, workflow_id,
          CASE WHEN phase_status = 'completed' THEN 1 ELSE 0 END,
          created_at, updated_at
        FROM repo_tasks;
        DROP TABLE repo_tasks;
        ALTER TABLE repo_tasks_new RENAME TO repo_tasks;
        CREATE INDEX IF NOT EXISTS idx_repo_tasks_requirement ON repo_tasks(requirement_id);
        CREATE INDEX IF NOT EXISTS idx_repo_tasks_repo ON repo_tasks(repo_id);
      `)
    })()
    db.pragma('foreign_keys = ON')
  }

  // Migration: add repo_id column to assignments for multi-repo orchestration
  const assignCols = db.prepare(`PRAGMA table_info(assignments)`).all() as { name: string }[]
  if (!assignCols.some(c => c.name === 'repo_id')) {
    db.exec(`ALTER TABLE assignments ADD COLUMN repo_id TEXT`)
  }

  // Migration: add workflow_completed flag to repo_tasks
  const taskCols3 = db.prepare(`PRAGMA table_info(repo_tasks)`).all() as { name: string }[]
  if (!taskCols3.some(c => c.name === 'workflow_completed')) {
    db.exec(`ALTER TABLE repo_tasks ADD COLUMN workflow_completed INTEGER NOT NULL DEFAULT 0`)
  }

  // Migration: add MCP probe result columns
  const mcpCols = db.prepare(`PRAGMA table_info(mcp_servers)`).all() as { name: string }[]
  if (!mcpCols.some(c => c.name === 'last_test_status')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN last_test_status TEXT CHECK (last_test_status IN ('success', 'error'))`)
  }
  if (!mcpCols.some(c => c.name === 'last_test_error')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN last_test_error TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'last_tested_at')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN last_tested_at TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'capabilities_json')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN capabilities_json TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'capabilities_summary')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN capabilities_summary TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'auth_type')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT CHECK (auth_type IN ('oauth'))`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_client_id')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_scope')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_scope TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_audience')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_audience TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_token_endpoint_auth_method')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_token_endpoint_auth_method TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_access_token')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_access_token TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_refresh_token')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_refresh_token TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_token_type')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_token_type TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_expires_at')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_expires_at TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_id_token')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_id_token TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_metadata_json')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_metadata_json TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_registration_json')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_registration_json TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_auth_state')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_auth_state TEXT CHECK (oauth_auth_state IN ('none', 'required', 'connected', 'unsupported', 'error'))`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_redirect_mode')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_redirect_mode TEXT CHECK (oauth_redirect_mode IN ('deeplink', 'loopback'))`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_last_error')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_last_error TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'oauth_connected_at')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN oauth_connected_at TEXT`)
  }
  if (!mcpCols.some(c => c.name === 'is_feishu_project')) {
    db.exec(`ALTER TABLE mcp_servers ADD COLUMN is_feishu_project INTEGER NOT NULL DEFAULT 0`)
  }
}
