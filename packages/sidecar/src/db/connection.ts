import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { applySchema } from './schema'

let _db: Database.Database | null = null

function loadNativeAddon(): object | undefined {
  try {
    const { isSea } = require('node:sea')
    if (!isSea()) return undefined
  }
  catch {
    return undefined
  }

  const execDir = dirname(process.execPath)
  const candidates = [
    join(execDir, 'better_sqlite3.node'),
    join(execDir, '..', 'Resources', 'better_sqlite3.node'),
  ]

  const addonPath = candidates.find(p => existsSync(p))
  if (!addonPath)
    throw new Error(`better_sqlite3.node not found in: ${candidates.join(', ')}`)

  const mod: { exports: Record<string, unknown> } = { exports: {} }
  process.dlopen(mod, addonPath)
  return mod.exports
}

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    const nativeBinding = loadNativeAddon()
    const opts: Record<string, unknown> = {}
    if (nativeBinding)
      opts.nativeBinding = nativeBinding
    _db = new Database(dbPath ?? 'code-agent.db', opts)
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
