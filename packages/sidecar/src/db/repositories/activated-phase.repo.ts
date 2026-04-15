import type Database from 'better-sqlite3'

export class ActivatedPhaseRepository {
  constructor(private db: Database.Database) {}

  activate(repoTaskId: string, phaseId: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO activated_phases (repo_task_id, phase_id) VALUES (?, ?)`,
    ).run(repoTaskId, phaseId)
  }

  isActivated(repoTaskId: string, phaseId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM activated_phases WHERE repo_task_id = ? AND phase_id = ?',
    ).get(repoTaskId, phaseId)
    return !!row
  }

  listByTask(repoTaskId: string): string[] {
    const rows = this.db.prepare(
      'SELECT phase_id FROM activated_phases WHERE repo_task_id = ?',
    ).all(repoTaskId) as { phase_id: string }[]
    return rows.map(r => r.phase_id)
  }

  deleteByTask(repoTaskId: string): void {
    this.db.prepare('DELETE FROM activated_phases WHERE repo_task_id = ?').run(repoTaskId)
  }
}
