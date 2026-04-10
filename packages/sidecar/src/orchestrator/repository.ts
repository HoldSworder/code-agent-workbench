import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  OrchestratorRun,
  Assignment,
  OrchestratorEvent,
  OrchestratorEventType,
  OrchestratorRunStatus,
  AssignmentStatus,
  CreateRunInput,
  CreateAssignmentInput,
} from './types'

export class OrchestratorRepository {
  constructor(private db: Database.Database) {}

  // ── Runs ──

  createRun(input: CreateRunInput): OrchestratorRun {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO orchestrator_runs (id, requirement_id, team_config)
         VALUES (?, ?, ?)`,
      )
      .run(id, input.requirement_id, input.team_config)
    return this.findRunById(id)!
  }

  createRunWithAssignments(
    input: CreateRunInput,
    assignments: Omit<CreateAssignmentInput, 'run_id'>[],
    leaderDecision: string,
  ): { run: OrchestratorRun, assignments: Assignment[] } {
    const runId = randomUUID()
    const result = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO orchestrator_runs (id, requirement_id, team_config, leader_decision)
           VALUES (?, ?, ?, ?)`,
        )
        .run(runId, input.requirement_id, input.team_config, leaderDecision)

      const created: Assignment[] = []
      for (const a of assignments) {
        const aId = randomUUID()
        this.db
          .prepare(
            `INSERT INTO assignments (id, run_id, role, title, description, acceptance_criteria, agent_provider, agent_model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(aId, runId, a.role, a.title, a.description, a.acceptance_criteria ?? null, a.agent_provider ?? null, a.agent_model ?? null)
        created.push(this.findAssignmentById(aId)!)

        this.appendEvent(runId, 'task_assigned', aId, JSON.stringify({
          role: a.role,
          title: a.title,
        }))
      }

      return created
    })()

    return { run: this.findRunById(runId)!, assignments: result }
  }

  findRunById(id: string): OrchestratorRun | undefined {
    return this.db.prepare('SELECT * FROM orchestrator_runs WHERE id = ?').get(id) as
      | OrchestratorRun
      | undefined
  }

  findRunsByRequirementId(requirementId: string): OrchestratorRun[] {
    return this.db
      .prepare('SELECT * FROM orchestrator_runs WHERE requirement_id = ? ORDER BY created_at DESC')
      .all(requirementId) as OrchestratorRun[]
  }

  findAllRuns(limit = 50, offset = 0): OrchestratorRun[] {
    return this.db
      .prepare('SELECT * FROM orchestrator_runs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as OrchestratorRun[]
  }

  updateRunStatus(id: string, status: OrchestratorRunStatus): void {
    const completedAt = ['completed', 'failed', 'blocked', 'cancelled'].includes(status)
      ? new Date().toISOString()
      : null
    this.db
      .prepare('UPDATE orchestrator_runs SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?')
      .run(status, completedAt, id)
  }

  updateRunLeaderDecision(id: string, leaderDecision: string): void {
    this.db
      .prepare('UPDATE orchestrator_runs SET leader_decision = ? WHERE id = ?')
      .run(leaderDecision, id)
  }

  updateRunRejectFeedback(id: string, feedback: string): void {
    this.db
      .prepare('UPDATE orchestrator_runs SET reject_feedback = ?, status = ? WHERE id = ?')
      .run(feedback, 'failed', id)
  }

  // ── Assignments ──

  createAssignment(input: CreateAssignmentInput): Assignment {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO assignments (id, run_id, role, title, description, acceptance_criteria, agent_provider, agent_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.run_id, input.role, input.title, input.description, input.acceptance_criteria ?? null, input.agent_provider ?? null, input.agent_model ?? null)
    return this.findAssignmentById(id)!
  }

  findAssignmentById(id: string): Assignment | undefined {
    return this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as
      | Assignment
      | undefined
  }

  findAssignmentsByRunId(runId: string): Assignment[] {
    return this.db
      .prepare('SELECT * FROM assignments WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Assignment[]
  }

  updateAssignmentStatus(id: string, status: AssignmentStatus, errorMessage?: string): void {
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status)
      ? new Date().toISOString()
      : null
    this.db
      .prepare(
        `UPDATE assignments
         SET status = ?, completed_at = COALESCE(?, completed_at), error_message = COALESCE(?, error_message)
         WHERE id = ?`,
      )
      .run(status, completedAt, errorMessage ?? null, id)
  }

  updateAssignmentWorktree(id: string, worktreePath: string, branchName: string): void {
    this.db
      .prepare('UPDATE assignments SET worktree_path = ?, branch_name = ? WHERE id = ?')
      .run(worktreePath, branchName, id)
  }

  // ── Events ──

  appendEvent(
    runId: string,
    eventType: OrchestratorEventType,
    assignmentId?: string | null,
    payload?: string | null,
  ): OrchestratorEvent {
    const result = this.db
      .prepare(
        `INSERT INTO orchestrator_events (run_id, assignment_id, event_type, payload)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, assignmentId ?? null, eventType, payload ?? null)
    return this.db
      .prepare('SELECT * FROM orchestrator_events WHERE id = ?')
      .get(result.lastInsertRowid) as OrchestratorEvent
  }

  getEvents(runId: string, afterId = 0, limit = 100): OrchestratorEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM orchestrator_events
         WHERE run_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(runId, afterId, limit) as OrchestratorEvent[]
  }

  getAllEvents(afterId = 0, limit = 100): OrchestratorEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM orchestrator_events
         WHERE id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit) as OrchestratorEvent[]
  }

  // ── Orchestrator-specific queries ──

  /**
   * Find requirements eligible for orchestrator pickup:
   * mode=orchestrator, status=pending, and no blocked run exists for them.
   */
  findPendingOrchestratorRequirements(): Array<{ id: string, title: string, description: string }> {
    return this.db
      .prepare(
        `SELECT r.id, r.title, r.description
         FROM requirements r
         WHERE r.mode = 'orchestrator'
           AND r.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM orchestrator_runs o
             WHERE o.requirement_id = r.id AND o.status = 'blocked'
           )
         ORDER BY r.created_at ASC`,
      )
      .all() as Array<{ id: string, title: string, description: string }>
  }

  findRequirementForDispatch(requirementId: string): { id: string, title: string, description: string } | null {
    return (this.db
      .prepare(
        `SELECT r.id, r.title, r.description
         FROM requirements r
         WHERE r.id = ?
           AND r.mode = 'orchestrator'
           AND r.status = 'pending'`,
      )
      .get(requirementId) as { id: string, title: string, description: string } | undefined) ?? null
  }

  findRequirementRaw(requirementId: string): { id: string, title: string, description: string, mode: string, status: string } | null {
    return (this.db
      .prepare('SELECT id, title, description, mode, status FROM requirements WHERE id = ?')
      .get(requirementId) as { id: string, title: string, description: string, mode: string, status: string } | undefined) ?? null
  }

  updateRequirementMode(requirementId: string, mode: string): void {
    this.db.prepare('UPDATE requirements SET mode = ? WHERE id = ?').run(mode, requirementId)
  }

  /**
   * Atomic CAS claim: pending → orchestrating. Returns true if claim succeeded.
   */
  claimRequirement(requirementId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE requirements SET status = 'orchestrating'
         WHERE id = ? AND status = 'pending' AND mode = 'orchestrator'`,
      )
      .run(requirementId)
    return result.changes > 0
  }

  updateRequirementStatus(requirementId: string, status: string): void {
    this.db.prepare('UPDATE requirements SET status = ? WHERE id = ?').run(status, requirementId)
  }

  /**
   * Startup recovery: rollback stuck orchestrating requirements
   * that have no running orchestrator_runs (11A decision).
   */
  recoverStuckRequirements(): number {
    const result = this.db
      .prepare(
        `UPDATE requirements SET status = 'pending'
         WHERE status = 'orchestrating'
           AND mode = 'orchestrator'
           AND NOT EXISTS (
             SELECT 1 FROM orchestrator_runs o
             WHERE o.requirement_id = requirements.id AND o.status = 'running'
           )`,
      )
      .run()
    return result.changes
  }

  /**
   * Get the most recent rejected run's feedback for a requirement.
   */
  getLastRejectFeedback(requirementId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT reject_feedback FROM orchestrator_runs
         WHERE requirement_id = ? AND reject_feedback IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(requirementId) as { reject_feedback: string } | undefined
    return row?.reject_feedback ?? null
  }
}
