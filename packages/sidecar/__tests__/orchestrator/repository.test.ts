import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema } from '../../src/db/schema'
import { OrchestratorRepository } from '../../src/orchestrator/repository'

function seedOrchestratorRequirement(db: Database.Database, id = 'req-1') {
  db.prepare(
    `INSERT INTO requirements (id, title, description, status, mode) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'Test Requirement', 'Description', 'pending', 'orchestrator')
}

describe('OrchestratorRepository', () => {
  let db: Database.Database
  let repo: OrchestratorRepository

  beforeEach(() => {
    db = new Database(':memory:')
    applySchema(db)
    repo = new OrchestratorRepository(db)
    seedOrchestratorRequirement(db)
  })

  afterEach(() => {
    db.close()
  })

  it('createRun and findRunById round-trip', () => {
    const run = repo.createRun({
      requirement_id: 'req-1',
      team_config: '{"name":"t"}',
    })
    expect(run.requirement_id).toBe('req-1')
    expect(run.team_config).toBe('{"name":"t"}')
    expect(run.status).toBe('running')
    expect(run.completed_at).toBeNull()

    const found = repo.findRunById(run.id)
    expect(found).toEqual(run)
  })

  it('createRunWithAssignments creates run, assignments, and events atomically', () => {
    const { run, assignments } = repo.createRunWithAssignments(
      { requirement_id: 'req-1', team_config: '{}' },
      [
        {
          role: 'worker',
          title: 'Task A',
          description: 'Desc A',
          acceptance_criteria: 'AC A',
          agent_provider: 'codex',
          agent_model: 'gpt-4',
        },
        {
          role: 'worker',
          title: 'Task B',
          description: 'Desc B',
          agent_provider: 'claude-code',
        },
      ],
      '{"decision":"split"}',
    )

    expect(run.leader_decision).toBe('{"decision":"split"}')
    expect(assignments).toHaveLength(2)
    expect(assignments[0]!.title).toBe('Task A')
    expect(assignments[1]!.title).toBe('Task B')

    const fromDb = repo.findAssignmentsByRunId(run.id)
    expect(fromDb).toHaveLength(2)

    const events = repo.getEvents(run.id, 0, 50)
    const assigned = events.filter(e => e.event_type === 'task_assigned')
    expect(assigned).toHaveLength(2)
    expect(assigned[0]!.assignment_id).toBe(assignments[0]!.id)
    expect(assigned[1]!.assignment_id).toBe(assignments[1]!.id)
  })

  it('updateRunStatus sets completed_at for terminal states', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    expect(run.completed_at).toBeNull()

    repo.updateRunStatus(run.id, 'completed')
    const after = repo.findRunById(run.id)!
    expect(after.status).toBe('completed')
    expect(after.completed_at).not.toBeNull()

    const run2 = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    repo.updateRunStatus(run2.id, 'running')
    expect(repo.findRunById(run2.id)!.completed_at).toBeNull()
  })

  it('createAssignment and findAssignmentsByRunId', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const a = repo.createAssignment({
      run_id: run.id,
      role: 'worker',
      title: 'T',
      description: 'D',
      agent_provider: 'codex',
    })
    const list = repo.findAssignmentsByRunId(run.id)
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(a.id)
    expect(list[0]!.status).toBe('pending')
  })

  it('updateAssignmentStatus sets completed_at for terminal assignment states', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const a = repo.createAssignment({
      run_id: run.id,
      role: 'worker',
      title: 'T',
      description: 'D',
    })
    expect(a.completed_at).toBeNull()

    repo.updateAssignmentStatus(a.id, 'completed')
    const updated = repo.findAssignmentById(a.id)!
    expect(updated.status).toBe('completed')
    expect(updated.completed_at).not.toBeNull()
  })

  it('updateAssignmentWorktree persists path and branch', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const a = repo.createAssignment({
      run_id: run.id,
      role: 'worker',
      title: 'T',
      description: 'D',
    })
    repo.updateAssignmentWorktree(a.id, '/tmp/wt', 'feature/x')
    const updated = repo.findAssignmentById(a.id)!
    expect(updated.worktree_path).toBe('/tmp/wt')
    expect(updated.branch_name).toBe('feature/x')
  })

  it('appendEvent and getEvents support afterId pagination', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const e1 = repo.appendEvent(run.id, 'leader_started', null, null)
    const e2 = repo.appendEvent(run.id, 'requirement_analyzed', null, '{"n":1}')
    const e3 = repo.appendEvent(run.id, 'run_completed', null, null)

    const first = repo.getEvents(run.id, 0, 2)
    expect(first.map(e => e.id)).toEqual([e1.id, e2.id])

    const rest = repo.getEvents(run.id, e2.id, 10)
    expect(rest.map(e => e.id)).toEqual([e3.id])
  })

  it('findPendingOrchestratorRequirements returns only orchestrator + pending without blocked run', () => {
    seedOrchestratorRequirement(db, 'req-wf')
    db.prepare(`UPDATE requirements SET mode = 'workflow' WHERE id = 'req-wf'`).run()

    seedOrchestratorRequirement(db, 'req-draft')
    db.prepare(`UPDATE requirements SET status = 'draft' WHERE id = 'req-draft'`).run()

    seedOrchestratorRequirement(db, 'req-blocked')
    const blockedRun = repo.createRun({ requirement_id: 'req-blocked', team_config: '{}' })
    repo.updateRunStatus(blockedRun.id, 'blocked')

    const pending = repo.findPendingOrchestratorRequirements()
    const ids = pending.map(r => r.id)
    expect(ids).toContain('req-1')
    expect(ids).not.toContain('req-wf')
    expect(ids).not.toContain('req-draft')
    expect(ids).not.toContain('req-blocked')
  })

  it('claimRequirement CAS: pending→orchestrating; second claim returns false', () => {
    expect(repo.claimRequirement('req-1')).toBe(true)
    expect(
      db.prepare(`SELECT status FROM requirements WHERE id = 'req-1'`).get() as { status: string },
    ).toEqual({ status: 'orchestrating' })

    expect(repo.claimRequirement('req-1')).toBe(false)
    expect(
      db.prepare(`SELECT status FROM requirements WHERE id = 'req-1'`).get() as { status: string },
    ).toEqual({ status: 'orchestrating' })
  })

  it('recoverStuckRequirements resets orchestrating→pending when no running run exists', () => {
    db.prepare(`UPDATE requirements SET status = 'orchestrating' WHERE id = 'req-1'`).run()
    const n = repo.recoverStuckRequirements()
    expect(n).toBe(1)
    expect(
      db.prepare(`SELECT status FROM requirements WHERE id = 'req-1'`).get() as { status: string },
    ).toEqual({ status: 'pending' })
  })

  it('recoverStuckRequirements does not reset when a running orchestrator run exists', () => {
    db.prepare(`UPDATE requirements SET status = 'orchestrating' WHERE id = 'req-1'`).run()
    repo.createRun({ requirement_id: 'req-1', team_config: '{}' })

    const n = repo.recoverStuckRequirements()
    expect(n).toBe(0)
    expect(
      db.prepare(`SELECT status FROM requirements WHERE id = 'req-1'`).get() as { status: string },
    ).toEqual({ status: 'orchestrating' })
  })

  it('createAssignment persists repo_id', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const a = repo.createAssignment({
      run_id: run.id,
      role: 'worker',
      repo_id: 'my-repo-id',
      title: 'T',
      description: 'D',
    })
    expect(a.repo_id).toBe('my-repo-id')

    const found = repo.findAssignmentById(a.id)!
    expect(found.repo_id).toBe('my-repo-id')
  })

  it('createAssignment defaults repo_id to null', () => {
    const run = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const a = repo.createAssignment({
      run_id: run.id,
      role: 'worker',
      title: 'T',
      description: 'D',
    })
    expect(a.repo_id).toBeNull()
  })

  it('findRepoById returns matching repo or null', () => {
    db.prepare(
      `INSERT INTO repos (id, name, local_path, default_branch) VALUES (?, ?, ?, ?)`,
    ).run('repo-1', 'frontend', '/path/to/frontend', 'main')

    const found = repo.findRepoById('repo-1')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('frontend')
    expect(found!.local_path).toBe('/path/to/frontend')

    expect(repo.findRepoById('nonexistent')).toBeNull()
  })

  it('getLastRejectFeedback returns the most recent non-null feedback', () => {
    const r1 = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })
    const r2 = repo.createRun({ requirement_id: 'req-1', team_config: '{}' })

    db.prepare(`UPDATE orchestrator_runs SET created_at = ?, reject_feedback = ? WHERE id = ?`).run(
      '2020-01-01T00:00:00.000Z',
      'older feedback',
      r1.id,
    )
    db.prepare(`UPDATE orchestrator_runs SET created_at = ?, reject_feedback = ? WHERE id = ?`).run(
      '2025-06-01T00:00:00.000Z',
      'newer feedback',
      r2.id,
    )

    expect(repo.getLastRejectFeedback('req-1')).toBe('newer feedback')
  })
})
