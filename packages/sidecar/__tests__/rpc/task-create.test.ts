import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { RpcServer } from '../../src/rpc/server'
import { registerMethods } from '../../src/rpc/methods'
import { WorkflowEngine } from '../../src/workflow/engine'
import { RepoRepository } from '../../src/db/repositories/repo.repo'
import { RequirementRepository } from '../../src/db/repositories/requirement.repo'
import type { AgentProvider } from '../../src/providers/types'
import * as gitOps from '../../src/git/operations'

const WORKFLOW_YAML = `
name: test
description: test workflow
phases:
  - id: design
    name: 设计
    requires_confirm: false
    provider: api
    skill: skills/design.md
`

describe('task.create RPC', () => {
  let db: Database.Database
  let server: RpcServer
  let repoId: string
  let requirementId: string

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)

    const repos = new RepoRepository(db)
    const reqs = new RequirementRepository(db)
    const r = repos.create({ name: 'app', local_path: '/tmp/app', default_branch: 'main' })
    const q = reqs.create({
      title: 'Hello World Feature',
      description: 'd',
      source: 'manual',
    })
    repoId = r.id
    requirementId = q.id

    vi.spyOn(gitOps, 'createWorktree').mockResolvedValue(undefined)

    const engine = new WorkflowEngine({
      db,
      workflowYaml: WORKFLOW_YAML,
      resolveProvider: (): AgentProvider => ({
        run: vi.fn().mockResolvedValue({ status: 'success', output: '' }),
        cancel: vi.fn().mockResolvedValue(undefined),
      }),
      resolveSkillContent: () => '',
    })

    server = new RpcServer()
    registerMethods(server, db, engine)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('creates task with slug change_id and calls createWorktree', async () => {
    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'task.create',
        params: { requirementId, repoId },
      }),
    )
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBeUndefined()
    expect(parsed.result.change_id).toBe('hello-world-feature')
    expect(parsed.result.branch_name).toBe('feature/hello-world-feature')
    expect(parsed.result.worktree_path).toBe('/tmp/app/.worktrees/hello-world-feature')
    expect(parsed.result.openspec_path).toBe('openspec/changes/hello-world-feature')
    expect(gitOps.createWorktree).toHaveBeenCalledWith(
      '/tmp/app',
      '/tmp/app/.worktrees/hello-world-feature',
      'feature/hello-world-feature',
      'main',
    )
  })

  it('returns error when requirement missing', async () => {
    const raw = await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'task.create',
        params: { requirementId: 'missing-req', repoId },
      }),
    )
    const parsed = JSON.parse(raw)
    expect(parsed.error.message).toMatch(/Requirement not found/)
  })
})
