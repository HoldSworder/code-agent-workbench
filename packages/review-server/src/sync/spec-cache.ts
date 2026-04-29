import type { SpecCacheRepository } from '../db/repositories/spec-cache.repo'

interface CacheEntry {
  content: string
  version: number
}

export interface ApplyPatchResult {
  ok: boolean
  conflict?: boolean
  currentVersion: number
  content: string
}

/**
 * 内存权威版本号 + 乐观锁。中心服务不再写飞书；飞书同步由 host 客户端负责。
 */
export class SpecSyncService {
  private cache = new Map<string, CacheEntry>()

  constructor(private repo: SpecCacheRepository) {}

  load(sessionId: string, content: string, version: number): CacheEntry {
    const entry: CacheEntry = { content, version }
    this.cache.set(sessionId, entry)
    this.repo.upsert(sessionId, content, version)
    return entry
  }

  get(sessionId: string): CacheEntry | null {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId)!
    const row = this.repo.get(sessionId)
    if (!row) return null
    return this.load(sessionId, row.content, row.version)
  }

  /**
   * 整段替换。版本不一致时返回 conflict。
   */
  applyPatch(sessionId: string, baseVersion: number, content: string): ApplyPatchResult {
    const entry = this.get(sessionId)
    if (!entry) return { ok: false, conflict: false, currentVersion: 0, content: '' }

    if (entry.version !== baseVersion) {
      return { ok: false, conflict: true, currentVersion: entry.version, content: entry.content }
    }

    entry.content = content
    entry.version += 1
    this.repo.upsert(sessionId, content, entry.version)
    return { ok: true, currentVersion: entry.version, content: entry.content }
  }

  evict(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}
