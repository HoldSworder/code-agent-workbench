import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { WorkflowEngine } from '../../src/workflow/engine'
import { RepoRepository } from '../../src/db/repositories/repo.repo'
import { RequirementRepository } from '../../src/db/repositories/requirement.repo'
import { RepoTaskRepository } from '../../src/db/repositories/repo-task.repo'
import type { AgentProvider, PhaseResult } from '../../src/providers/types'

function createMockProvider(result: PhaseResult): AgentProvider {
  return {
    run: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(undefined),
  }
}

const WORKFLOW_YAML = `
name: test
description: test workflow
phases:
  - id: design
    name: 设计
    requires_confirm: true
    provider: api
    skill: skills/design.md
  - id: dev
    name: 开发
    requires_confirm: false
    provider: external-cli
    skill: skills/dev.md
  - id: verify
    name: 验证
    requires_confirm: false
    provider: script
    script: scripts/verify.sh
`

describe('WorkflowEngine', () => {
  let db: Database.Database
  let engine: WorkflowEngine
  let mockProvider: AgentProvider
  let taskId: string

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)

    const repoRepo = new RepoRepository(db)
    const reqRepo = new RequirementRepository(db)
    const r = repoRepo.create({ name: 'app', local_path: '/tmp/app', default_branch: 'main' })
    const req = reqRepo.create({ title: 'test', description: '', source: 'manual' })

    const taskRepo = new RepoTaskRepository(db)
    const task = taskRepo.create({
      requirement_id: req.id,
      repo_id: r.id,
      branch_name: 'feature/test',
      change_id: 'test',
      openspec_path: 'openspec/changes/test',
      worktree_path: '/tmp/app/.worktrees/test',
    })
    taskId = task.id

    mockProvider = createMockProvider({ status: 'success', output: 'done' })

    engine = new WorkflowEngine({
      db,
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: () => mockProvider,
      resolveSkillContent: () => 'skill content',
    })
  })

  afterEach(() => db.close())

  it('starts workflow and runs first phase', async () => {
    await engine.startWorkflow(taskId)
    expect(mockProvider.run).toHaveBeenCalledOnce()

    const task = new RepoTaskRepository(db).findById(taskId)!
    expect(task.current_phase).toBe('design')
    expect(task.phase_status).toBe('waiting_confirm')
  })

  it('confirmPhase advances to next phase', async () => {
    await engine.startWorkflow(taskId)
    await engine.confirmPhase(taskId)

    const task = new RepoTaskRepository(db).findById(taskId)!
    expect(task.phase_status).toBe('waiting_event')
  })

  it('provideFeedback re-runs the current phase', async () => {
    await engine.startWorkflow(taskId)
    await engine.provideFeedback(taskId, 'please adjust the proposal')

    const task = new RepoTaskRepository(db).findById(taskId)!
    expect(task.current_phase).toBe('design')
    expect(task.phase_status).toBe('waiting_confirm')
    expect(mockProvider.run).toHaveBeenCalledTimes(2)
  })

  it('handles agent failure', async () => {
    const failProvider = createMockProvider({ status: 'failed', error: 'crash' })
    engine = new WorkflowEngine({
      db,
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: () => failProvider,
      resolveSkillContent: () => '',
    })

    await engine.startWorkflow(taskId)
    const task = new RepoTaskRepository(db).findById(taskId)!
    expect(task.phase_status).toBe('failed')
  })

  it('throws if confirming a task not in waiting_confirm', async () => {
    await expect(engine.confirmPhase(taskId)).rejects.toThrow()
  })
})
