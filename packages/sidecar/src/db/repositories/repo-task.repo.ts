import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_stage: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
  base_sha: string | null
  workflow_id: string | null
  workflow_completed: number
  /** 任务生命周期：active（开发中）/ pending_merge（已发 MR，等合并）/ archived（已清理） */
  lifecycle_status: 'active' | 'pending_merge' | 'archived'
  created_at: string
  updated_at: string
}

export interface CreateRepoTaskInput {
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  openspec_path: string
  worktree_path: string
  base_sha?: string | null
  workflow_id?: string
}

export class RepoTaskRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateRepoTaskInput): RepoTask {
    const id = randomUUID()
    this.db
      .prepare(
        `
      INSERT INTO repo_tasks (
        id, requirement_id, repo_id, branch_name, change_id,
        current_stage, current_phase, phase_status,
        openspec_path, worktree_path, base_sha, workflow_id
      )
      VALUES (?, ?, ?, ?, ?, 'planning', 'task-breakdown', 'pending', ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        input.requirement_id,
        input.repo_id,
        input.branch_name,
        input.change_id,
        input.openspec_path,
        input.worktree_path,
        input.base_sha ?? null,
        input.workflow_id ?? null,
      )
    return this.findById(id)!
  }

  findById(id: string): RepoTask | undefined {
    return this.db.prepare('SELECT * FROM repo_tasks WHERE id = ?').get(id) as RepoTask | undefined
  }

  findAll(): RepoTask[] {
    return this.db
      .prepare('SELECT * FROM repo_tasks ORDER BY created_at DESC')
      .all() as RepoTask[]
  }

  findByRepoId(repoId: string): RepoTask[] {
    return this.db
      .prepare('SELECT * FROM repo_tasks WHERE repo_id = ? ORDER BY created_at DESC')
      .all(repoId) as RepoTask[]
  }

  findByRequirementId(requirementId: string): RepoTask[] {
    return this.db
      .prepare(
        'SELECT * FROM repo_tasks WHERE requirement_id = ? ORDER BY created_at DESC',
      )
      .all(requirementId) as RepoTask[]
  }

  updateWorkflowId(id: string, workflow_id: string | null): void {
    this.db
      .prepare(
        `
      UPDATE repo_tasks
      SET workflow_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
      )
      .run(workflow_id, id)
  }

  updateChangeInfo(id: string, branchName: string, changeId: string, openspecPath: string): void {
    this.db
      .prepare(
        `
      UPDATE repo_tasks
      SET branch_name = ?, change_id = ?, openspec_path = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
      )
      .run(branchName, changeId, openspecPath, id)
  }

  updateWorktreePath(id: string, worktreePath: string): void {
    this.db
      .prepare(`UPDATE repo_tasks SET worktree_path = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(worktreePath, id)
  }

  markWorkflowCompleted(id: string): void {
    this.db
      .prepare(`UPDATE repo_tasks SET workflow_completed = 1, updated_at = datetime('now') WHERE id = ?`)
      .run(id)
  }

  setLifecycleStatus(id: string, status: 'active' | 'pending_merge' | 'archived'): void {
    this.db
      .prepare(`UPDATE repo_tasks SET lifecycle_status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id)
  }

  markPendingMerge(id: string): void {
    this.setLifecycleStatus(id, 'pending_merge')
  }

  markArchived(id: string): void {
    this.setLifecycleStatus(id, 'archived')
  }

  updatePhase(id: string, currentStage: string, currentPhase: string, phaseStatus: string): void {
    this.db
      .prepare(
        `
      UPDATE repo_tasks
      SET current_stage = ?, current_phase = ?, phase_status = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
      )
      .run(currentStage, currentPhase, phaseStatus, id)
  }

  delete(id: string): void {
    const deleteRelated = this.db.transaction(() => {
      this.db.prepare('DELETE FROM activated_phases WHERE repo_task_id = ?').run(id)
      this.db.prepare('DELETE FROM assignment_commits WHERE repo_task_id = ?').run(id)
      this.db.prepare('DELETE FROM phase_commits WHERE repo_task_id = ?').run(id)
      this.db.prepare('DELETE FROM conversation_messages WHERE repo_task_id = ?').run(id)
      this.db.prepare('DELETE FROM agent_runs WHERE repo_task_id = ?').run(id)
      this.db.prepare('DELETE FROM repo_tasks WHERE id = ?').run(id)
    })
    deleteRelated()
  }

  deleteByRequirementId(requirementId: string): void {
    const taskIds = this.findByRequirementId(requirementId).map(t => t.id)
    for (const id of taskIds) this.delete(id)
  }
}
