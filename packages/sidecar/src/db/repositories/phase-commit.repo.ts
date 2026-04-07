import type Database from 'better-sqlite3'

export const INITIAL_PHASE_ID = '__initial__'

export class PhaseCommitRepository {
  constructor(private db: Database.Database) {}

  save(repoTaskId: string, phaseId: string, commitSha: string): void {
    this.db.prepare(
      `INSERT INTO phase_commits (repo_task_id, phase_id, commit_sha)
       VALUES (?, ?, ?)
       ON CONFLICT(repo_task_id, phase_id) DO UPDATE SET commit_sha = excluded.commit_sha, created_at = datetime('now')`,
    ).run(repoTaskId, phaseId, commitSha)
  }

  get(repoTaskId: string, phaseId: string): string | null {
    const row = this.db.prepare(
      'SELECT commit_sha FROM phase_commits WHERE repo_task_id = ? AND phase_id = ?',
    ).get(repoTaskId, phaseId) as { commit_sha: string } | undefined
    return row?.commit_sha ?? null
  }

  deleteByTaskAndPhases(repoTaskId: string, phaseIds: string[]): void {
    if (!phaseIds.length) return
    const placeholders = phaseIds.map(() => '?').join(',')
    this.db.prepare(
      `DELETE FROM phase_commits WHERE repo_task_id = ? AND phase_id IN (${placeholders})`,
    ).run(repoTaskId, ...phaseIds)
  }

  deleteByTask(repoTaskId: string): void {
    this.db.prepare('DELETE FROM phase_commits WHERE repo_task_id = ?').run(repoTaskId)
  }
}
