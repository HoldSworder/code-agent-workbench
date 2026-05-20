import type Database from 'better-sqlite3'

export interface AssignmentCommit {
  assignment_id: string
  repo_task_id: string
  phase_id: string
  branch_name: string
  worker_head_sha: string
  merge_sha: string
  base_sha: string
  created_at: string
}

export interface UpsertAssignmentCommitInput {
  assignment_id: string
  repo_task_id: string
  phase_id: string
  branch_name: string
  worker_head_sha: string
  merge_sha: string
  base_sha: string
}

export class AssignmentCommitRepository {
  constructor(private db: Database.Database) {}

  upsert(input: UpsertAssignmentCommitInput): void {
    this.db
      .prepare(
        `INSERT INTO assignment_commits (
           assignment_id, repo_task_id, phase_id, branch_name,
           worker_head_sha, merge_sha, base_sha
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(assignment_id) DO UPDATE SET
           phase_id = excluded.phase_id,
           branch_name = excluded.branch_name,
           worker_head_sha = excluded.worker_head_sha,
           merge_sha = excluded.merge_sha,
           base_sha = excluded.base_sha`,
      )
      .run(
        input.assignment_id,
        input.repo_task_id,
        input.phase_id,
        input.branch_name,
        input.worker_head_sha,
        input.merge_sha,
        input.base_sha,
      )
  }

  findById(assignmentId: string): AssignmentCommit | undefined {
    return this.db
      .prepare('SELECT * FROM assignment_commits WHERE assignment_id = ?')
      .get(assignmentId) as AssignmentCommit | undefined
  }

  findByTask(repoTaskId: string): AssignmentCommit[] {
    return this.db
      .prepare(
        'SELECT * FROM assignment_commits WHERE repo_task_id = ? ORDER BY created_at ASC',
      )
      .all(repoTaskId) as AssignmentCommit[]
  }

  findByTaskAndPhases(repoTaskId: string, phaseIds: string[]): AssignmentCommit[] {
    if (phaseIds.length === 0) return []
    const placeholders = phaseIds.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT * FROM assignment_commits
         WHERE repo_task_id = ? AND phase_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(repoTaskId, ...phaseIds) as AssignmentCommit[]
  }

  deleteByTaskAndPhases(repoTaskId: string, phaseIds: string[]): void {
    if (phaseIds.length === 0) return
    const placeholders = phaseIds.map(() => '?').join(',')
    this.db
      .prepare(
        `DELETE FROM assignment_commits WHERE repo_task_id = ? AND phase_id IN (${placeholders})`,
      )
      .run(repoTaskId, ...phaseIds)
  }

  deleteById(assignmentId: string): void {
    this.db.prepare('DELETE FROM assignment_commits WHERE assignment_id = ?').run(assignmentId)
  }
}
