import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { RepoRepository } from '../../src/db/repositories/repo.repo'
import { RequirementRepository } from '../../src/db/repositories/requirement.repo'
import { RepoTaskRepository } from '../../src/db/repositories/repo-task.repo'
import { AgentRunRepository } from '../../src/db/repositories/agent-run.repo'
import { MessageRepository } from '../../src/db/repositories/message.repo'

describe('RepoRepository', () => {
  let db: Database.Database
  let repos: RepoRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    repos = new RepoRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates and retrieves by id', () => {
    const created = repos.create({
      name: 'my-app',
      local_path: '/tmp/my-app',
      default_branch: 'main',
    })
    expect(created.id).toBeDefined()
    expect(created.name).toBe('my-app')
    expect(created.local_path).toBe('/tmp/my-app')
    expect(created.default_branch).toBe('main')
    expect(created.agent_provider).toBeNull()
    expect(created.created_at).toBeDefined()

    const found = repos.findById(created.id)
    expect(found).toEqual(created)
  })

  it('stores optional agent_provider', () => {
    const created = repos.create({
      name: 'x',
      local_path: '/tmp/x',
      default_branch: 'develop',
      agent_provider: 'claude',
    })
    expect(created.agent_provider).toBe('claude')
  })

  it('lists all ordered by created_at desc', () => {
    const a = repos.create({ name: 'a', local_path: '/tmp/a', default_branch: 'main' })
    const b = repos.create({ name: 'b', local_path: '/tmp/b', default_branch: 'main' })
    const all = repos.findAll()
    expect(all.map((r) => r.id)).toEqual([b.id, a.id])
  })

  it('deletes by id', () => {
    const r = repos.create({ name: 'x', local_path: '/tmp/x', default_branch: 'main' })
    repos.delete(r.id)
    expect(repos.findById(r.id)).toBeUndefined()
  })
})

describe('RequirementRepository', () => {
  let db: Database.Database
  let requirements: RequirementRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    requirements = new RequirementRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates and lists', () => {
    const r = requirements.create({
      title: 'Feature X',
      description: 'Do the thing',
      source: 'manual',
      source_url: 'https://example.com/issue/1',
    })
    expect(r.title).toBe('Feature X')
    expect(r.status).toBe('draft')
    const all = requirements.findAll()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(r.id)
  })

  it('updates status', () => {
    const r = requirements.create({
      title: 't',
      description: 'd',
      source: 'feishu',
    })
    requirements.updateStatus(r.id, 'done')
    const found = requirements.findById(r.id)
    expect(found?.status).toBe('done')
  })
})

describe('RepoTaskRepository', () => {
  let db: Database.Database
  let repoTasks: RepoTaskRepository
  let repoId: string
  let requirementId: string

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    const repos = new RepoRepository(db)
    const reqs = new RequirementRepository(db)
    const r = repos.create({ name: 'p', local_path: '/tmp/p', default_branch: 'main' })
    const q = reqs.create({ title: 't', description: 'd', source: 'manual' })
    repoId = r.id
    requirementId = q.id
    repoTasks = new RepoTaskRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates linked to repo and requirement', () => {
    const t = repoTasks.create({
      requirement_id: requirementId,
      repo_id: repoId,
      branch_name: 'feat/x',
      change_id: 'chg-1',
      openspec_path: 'openspec/changes/chg-1',
      worktree_path: '/tmp/wt',
    })
    expect(t.requirement_id).toBe(requirementId)
    expect(t.repo_id).toBe(repoId)
    expect(t.current_phase).toBe('design')
    expect(t.phase_status).toBe('running')
    expect(repoTasks.findById(t.id)).toEqual(t)
  })

  it('updates phase and status', () => {
    const t = repoTasks.create({
      requirement_id: requirementId,
      repo_id: repoId,
      branch_name: 'b',
      change_id: 'c',
      openspec_path: 'o',
      worktree_path: 'w',
    })
    repoTasks.updatePhase(t.id, 'implement', 'done')
    const found = repoTasks.findById(t.id)
    expect(found?.current_phase).toBe('implement')
    expect(found?.phase_status).toBe('done')
  })

  it('findByRepoId and findByRequirementId', () => {
    const t1 = repoTasks.create({
      requirement_id: requirementId,
      repo_id: repoId,
      branch_name: 'b1',
      change_id: 'c1',
      openspec_path: 'o1',
      worktree_path: 'w1',
    })
    const t2 = repoTasks.create({
      requirement_id: requirementId,
      repo_id: repoId,
      branch_name: 'b2',
      change_id: 'c2',
      openspec_path: 'o2',
      worktree_path: 'w2',
    })
    expect(repoTasks.findByRepoId(repoId).map((x) => x.id).sort()).toEqual(
      [t1.id, t2.id].sort(),
    )
    expect(repoTasks.findByRequirementId(requirementId).map((x) => x.id).sort()).toEqual(
      [t1.id, t2.id].sort(),
    )
  })
})

describe('AgentRunRepository', () => {
  let db: Database.Database
  let agentRuns: AgentRunRepository
  let repoTaskId: string

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    const repos = new RepoRepository(db)
    const reqs = new RequirementRepository(db)
    const tasks = new RepoTaskRepository(db)
    const r = repos.create({ name: 'p', local_path: '/tmp/p', default_branch: 'main' })
    const q = reqs.create({ title: 't', description: 'd', source: 'manual' })
    const t = tasks.create({
      requirement_id: q.id,
      repo_id: r.id,
      branch_name: 'b',
      change_id: 'c',
      openspec_path: 'o',
      worktree_path: 'w',
    })
    repoTaskId = t.id
    agentRuns = new AgentRunRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates a run', () => {
    const run = agentRuns.create({
      repo_task_id: repoTaskId,
      phase_id: 'design',
      provider: 'claude',
    })
    expect(run.status).toBe('running')
    expect(run.repo_task_id).toBe(repoTaskId)
    expect(agentRuns.findById(run.id)).toEqual(run)
  })

  it('finish updates status, finished_at, token_usage, error', () => {
    const run = agentRuns.create({
      repo_task_id: repoTaskId,
      phase_id: 'design',
      provider: 'claude',
    })
    agentRuns.finish(run.id, 'succeeded', 42, undefined)
    const found = agentRuns.findById(run.id)
    expect(found?.status).toBe('succeeded')
    expect(found?.finished_at).toBeTruthy()
    expect(found?.token_usage).toBe(42)
    expect(found?.error).toBeNull()

    agentRuns.finish(run.id, 'failed', undefined, 'boom')
    const failed = agentRuns.findById(run.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('boom')
  })

  it('findByTaskId returns runs for task', () => {
    const a = agentRuns.create({
      repo_task_id: repoTaskId,
      phase_id: 'design',
      provider: 'p1',
    })
    const b = agentRuns.create({
      repo_task_id: repoTaskId,
      phase_id: 'implement',
      provider: 'p2',
    })
    const list = agentRuns.findByTaskId(repoTaskId)
    expect(list.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  })
})

describe('MessageRepository', () => {
  let db: Database.Database
  let messages: MessageRepository
  let repoTaskId: string

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    const repos = new RepoRepository(db)
    const reqs = new RequirementRepository(db)
    const tasks = new RepoTaskRepository(db)
    const r = repos.create({ name: 'p', local_path: '/tmp/p', default_branch: 'main' })
    const q = reqs.create({ title: 't', description: 'd', source: 'manual' })
    const t = tasks.create({
      requirement_id: q.id,
      repo_id: r.id,
      branch_name: 'b',
      change_id: 'c',
      openspec_path: 'o',
      worktree_path: 'w',
    })
    repoTaskId = t.id
    messages = new MessageRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates and findByTaskAndPhase orders by created_at', () => {
    const m1 = messages.create({
      repo_task_id: repoTaskId,
      phase_id: 'design',
      role: 'user',
      content: 'hello',
    })
    const m2 = messages.create({
      repo_task_id: repoTaskId,
      phase_id: 'design',
      role: 'assistant',
      content: 'hi',
    })
    const list = messages.findByTaskAndPhase(repoTaskId, 'design')
    expect(list.map((m) => m.id)).toEqual([m1.id, m2.id])
  })
})
