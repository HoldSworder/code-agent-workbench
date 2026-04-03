import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
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
        openspec_path, worktree_path
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
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

  updatePhase(id: string, currentPhase: string, phaseStatus: string): void {
    this.db
      .prepare(
        `
      UPDATE repo_tasks
      SET current_phase = ?, phase_status = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
      )
      .run(currentPhase, phaseStatus, id)
  }
}
