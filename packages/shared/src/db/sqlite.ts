import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

export interface CreateSqliteOptions {
  /** 数据库文件路径（绝对/相对均可）。 */
  dbPath: string
  /** 启动时执行的 schema/迁移函数（同步）。 */
  applySchema?: (db: Database.Database) => void
  /**
   * SEA 打包场景下从 process.execPath 旁的 `better_sqlite3.node` 加载原生模块。
   * 默认 false；sidecar 单文件分发时设为 true。
   */
  loadSeaNativeAddon?: boolean
  /** 是否自动创建父目录（默认 true）。 */
  ensureDir?: boolean
  /** 自定义 pragma（默认 `journal_mode = WAL` + `foreign_keys = ON`）。 */
  pragmas?: string[]
}

const DEFAULT_PRAGMAS = ['journal_mode = WAL', 'foreign_keys = ON']

function loadNativeAddon(): object | undefined {
  try {
    const seaModule = require('node:sea') as { isSea?: () => boolean }
    if (!seaModule.isSea?.()) return undefined
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

/**
 * 创建/打开一个 SQLite 数据库连接，自动应用 pragma 和 schema。
 *
 * 调用方负责通过模块级缓存管理"单例"语义；本函数每次调用都会真的打开连接。
 */
export function createSqliteConnection(opts: CreateSqliteOptions): Database.Database {
  if (opts.ensureDir !== false) {
    try { mkdirSync(dirname(opts.dbPath), { recursive: true }) }
    catch { /* ignore */ }
  }

  const dbOpts: Record<string, unknown> = {}
  if (opts.loadSeaNativeAddon) {
    const nativeBinding = loadNativeAddon()
    if (nativeBinding) dbOpts.nativeBinding = nativeBinding
  }

  const db = new Database(opts.dbPath, dbOpts)
  for (const pragma of (opts.pragmas ?? DEFAULT_PRAGMAS))
    db.pragma(pragma)
  opts.applySchema?.(db)
  return db
}
