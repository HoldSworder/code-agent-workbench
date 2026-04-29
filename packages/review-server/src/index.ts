import { loadConfig } from './config'
import { getDb } from './db/connection'
import { SessionRepository } from './db/repositories/session.repo'
import { ClarificationRepository } from './db/repositories/clarification.repo'
import { SpecCacheRepository } from './db/repositories/spec-cache.repo'
import { AssessmentRepository } from './db/repositories/assessment.repo'
import { Broadcaster } from './ws/broadcaster'
import { SpecSyncService } from './sync/spec-cache'
import { buildHttpServer } from './http/server'
import { attachWebSocketServer } from './ws/server'
import type { ServerContext } from './http/context'

async function main(): Promise<void> {
  const config = loadConfig()
  const db = getDb(config.dbPath)

  const sessionRepo = new SessionRepository(db)
  const clarificationRepo = new ClarificationRepository(db)
  const specCacheRepo = new SpecCacheRepository(db)
  const assessmentRepo = new AssessmentRepository(db)

  const broadcaster = new Broadcaster()
  const specSync = new SpecSyncService(specCacheRepo)

  const ctx: ServerContext = {
    config,
    broadcaster,
    specSync,
    sessionRepo,
    clarificationRepo,
    assessmentRepo,
  }

  const httpServer = buildHttpServer(ctx)
  attachWebSocketServer(httpServer, ctx)

  httpServer.listen(config.port, '0.0.0.0', () => {
    process.stderr.write(`review-server: listening on http://0.0.0.0:${config.port}\n`)
    process.stderr.write(`  db path: ${config.dbPath}\n`)
  })

  const shutdown = (signal: string): void => {
    process.stderr.write(`review-server: received ${signal}, shutting down...\n`)
    httpServer.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  process.stderr.write(`review-server: fatal ${err}\n`)
  process.exit(1)
})
