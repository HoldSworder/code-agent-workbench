import type { RpcServer } from './server'
import type Database from 'better-sqlite3'
import { RepoRepository } from '../db/repositories/repo.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import type { WorkflowEngine } from '../workflow/engine'

export function registerMethods(
  server: RpcServer,
  db: Database.Database,
  engine: WorkflowEngine,
): void {
  const repoRepo = new RepoRepository(db)
  const reqRepo = new RequirementRepository(db)
  const taskRepo = new RepoTaskRepository(db)
  const msgRepo = new MessageRepository(db)

  // Repo CRUD
  server.register('repo.list', async () => repoRepo.findAll())
  server.register('repo.create', async (params) => repoRepo.create(params))
  server.register('repo.delete', async ({ id }) => repoRepo.delete(id))

  // Requirement CRUD
  server.register('requirement.list', async () => reqRepo.findAll())
  server.register('requirement.create', async (params) => reqRepo.create(params))
  server.register('requirement.get', async ({ id }) => reqRepo.findById(id))

  // RepoTask
  server.register('task.listByRepo', async ({ repoId }) => taskRepo.findByRepoId(repoId))
  server.register('task.listByRequirement', async ({ requirementId }) =>
    taskRepo.findByRequirementId(requirementId),
  )
  server.register('task.get', async ({ id }) => taskRepo.findById(id))

  // Conversation
  server.register('message.list', async ({ taskId, phaseId }) =>
    msgRepo.findByTaskAndPhase(taskId, phaseId),
  )

  // Workflow actions
  server.register('workflow.start', async ({ repoTaskId }) => {
    await engine.startWorkflow(repoTaskId)
    return { ok: true }
  })
  server.register('workflow.confirm', async ({ repoTaskId }) => {
    await engine.confirmPhase(repoTaskId)
    return { ok: true }
  })
  server.register('workflow.feedback', async ({ repoTaskId, feedback }) => {
    await engine.provideFeedback(repoTaskId, feedback)
    return { ok: true }
  })
  server.register('workflow.triggerEvent', async ({ repoTaskId, eventId }) => {
    await engine.triggerEvent(repoTaskId, eventId)
    return { ok: true }
  })
  server.register('workflow.cancel', async ({ repoTaskId }) => {
    await engine.cancelCurrentAgent(repoTaskId)
    return { ok: true }
  })
}
