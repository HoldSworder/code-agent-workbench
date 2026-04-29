import type { ServerConfig } from '../config'
import type { Broadcaster } from '../ws/broadcaster'
import type { SpecSyncService } from '../sync/spec-cache'
import type { SessionRepository } from '../db/repositories/session.repo'
import type { ClarificationRepository } from '../db/repositories/clarification.repo'
import type { AssessmentRepository } from '../db/repositories/assessment.repo'

export interface ServerContext {
  config: ServerConfig
  broadcaster: Broadcaster
  specSync: SpecSyncService
  sessionRepo: SessionRepository
  clarificationRepo: ClarificationRepository
  assessmentRepo: AssessmentRepository
}
