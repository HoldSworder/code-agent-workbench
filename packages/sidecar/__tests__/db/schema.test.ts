import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'

describe('database schema', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('creates all tables', () => {
    applySchema(db)

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name)

    expect(tables).toContain('repos')
    expect(tables).toContain('requirements')
    expect(tables).toContain('repo_tasks')
    expect(tables).toContain('agent_runs')
    expect(tables).toContain('conversation_messages')
  })

  it('is idempotent', () => {
    applySchema(db)
    applySchema(db)
    const count = db
      .prepare(`SELECT count(*) as c FROM sqlite_master WHERE type='table'`)
      .get() as any
    expect(count.c).toBeGreaterThan(0)
  })
})
