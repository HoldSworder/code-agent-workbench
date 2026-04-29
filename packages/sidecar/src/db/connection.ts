import type Database from 'better-sqlite3'
import { createSqliteConnection } from '@code-agent/shared/db'
import { applySchema } from './schema'

let _db: Database.Database | null = null

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    _db = createSqliteConnection({
      dbPath: dbPath ?? 'code-agent.db',
      applySchema,
      loadSeaNativeAddon: true,
    })
  }
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}
