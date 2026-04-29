import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../src/db/schema'
import { SessionRepository } from '../src/db/repositories/session.repo'
import { SpecCacheRepository } from '../src/db/repositories/spec-cache.repo'
import { SpecSyncService } from '../src/sync/spec-cache'

function makeService() {
  const db = new Database(':memory:')
  applySchema(db)
  const sessionRepo = new SessionRepository(db)
  const specRepo = new SpecCacheRepository(db)
  const session = sessionRepo.create({
    requirementId: 'R1',
    requirementTitle: 'demo',
    relatedRepos: [],
    hostUserId: 'u1',
    hostUserName: 'tester',
  })
  const svc = new SpecSyncService(specRepo)
  return { svc, sessionId: session.id }
}

describe('SpecSyncService', () => {
  it('initial load + applyPatch increments version', () => {
    const { svc, sessionId } = makeService()
    svc.load(sessionId, 'v0', 0)
    const result = svc.applyPatch(sessionId, 0, 'v1')
    expect(result.ok).toBe(true)
    expect(result.currentVersion).toBe(1)
    expect(result.content).toBe('v1')
  })

  it('rejects stale baseVersion as conflict', () => {
    const { svc, sessionId } = makeService()
    svc.load(sessionId, 'v0', 0)
    svc.applyPatch(sessionId, 0, 'v1')
    const stale = svc.applyPatch(sessionId, 0, 'v2')
    expect(stale.ok).toBe(false)
    expect(stale.conflict).toBe(true)
    expect(stale.currentVersion).toBe(1)
    expect(stale.content).toBe('v1')
  })

  it('returns failure for unknown session', () => {
    const { svc } = makeService()
    const r = svc.applyPatch('nope', 0, 'x')
    expect(r.ok).toBe(false)
  })
})
