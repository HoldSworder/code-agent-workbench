import Database from 'better-sqlite3'
import { applySchema } from './schema'

let _db: Database.Database | null = null

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    _db = new Database(dbPath ?? 'code-agent.db')
    _db.pragma('journal_mode = WAL')
    _db.pragma('foreign_keys = ON')
    applySchema(_db)
  }
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}
