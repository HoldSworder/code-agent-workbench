import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from '../providers/types'
import { createWorktree, removeWorktree } from '../git/operations'
import type { OrchestratorRepository } from './repository'
import type { Assignment, RoleConfig } from './types'

export interface WorkerRunnerDeps {
  repo: OrchestratorRepository
  resolveProvider: (role: RoleConfig) => AgentProvider
  repoPath: string
  defaultBranch: string
  onChunk?: RunOptions['onChunk']
}

export interface WorkerResult {
  assignment: Assignment
  phaseResult: PhaseResult
}

export async function runWorker(
  deps: WorkerRunnerDeps,
  assignment: Assignment,
  role: RoleConfig,
  requirementContext: string,
): Promise<WorkerResult> {
  const { repo, resolveProvider, repoPath, defaultBranch, onChunk } = deps
  const branchName = `orchestrator/${assignment.run_id.slice(0, 8)}/${assignment.role}-${randomUUID().slice(0, 6)}`
  const worktreePath = join(tmpdir(), `code-agent-worker-${assignment.id.slice(0, 8)}`)

  repo.updateAssignmentStatus(assignment.id, 'running')
  repo.updateAssignmentWorktree(assignment.id, worktreePath, branchName)
  repo.appendEvent(assignment.run_id, 'worker_started', assignment.id, JSON.stringify({
    role: assignment.role,
    branch: branchName,
    worktree: worktreePath,
  }))

  try {
    await createWorktree(repoPath, worktreePath, branchName, defaultBranch)
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    repo.updateAssignmentStatus(assignment.id, 'failed', `worktree creation failed: ${msg}`)
    repo.appendEvent(assignment.run_id, 'worker_failed', assignment.id, JSON.stringify({ error: msg }))
    return {
      assignment: repo.findAssignmentById(assignment.id)!,
      phaseResult: { status: 'failed', error: msg },
    }
  }

  const provider = resolveProvider(role)
  const context: PhaseContext = {
    stageId: 'orchestrator',
    stageName: 'Orchestrator',
    phaseId: `worker-${assignment.role}`,
    repoPath: worktreePath,
    openspecPath: worktreePath,
    branchName,
    skillContent: buildWorkerPrompt(role, assignment, requirementContext),
    requirementTitle: assignment.title,
    requirementDescription: assignment.description,
  }

  let phaseResult: PhaseResult
  try {
    phaseResult = await provider.run(context, { onChunk })
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    phaseResult = { status: 'failed', error: msg }
  }

  if (phaseResult.status === 'success') {
    repo.updateAssignmentStatus(assignment.id, 'completed')
    repo.appendEvent(assignment.run_id, 'worker_completed', assignment.id, JSON.stringify({
      output: phaseResult.output?.slice(0, 500),
    }))
  }
  else {
    const eventType = phaseResult.error?.includes('timeout') ? 'worker_timeout' : 'worker_failed'
    repo.updateAssignmentStatus(assignment.id, 'failed', phaseResult.error)
    repo.appendEvent(assignment.run_id, eventType, assignment.id, JSON.stringify({
      error: phaseResult.error,
    }))
  }

  await cleanupWorktree(repoPath, worktreePath)

  return {
    assignment: repo.findAssignmentById(assignment.id)!,
    phaseResult,
  }
}

function buildWorkerPrompt(
  role: RoleConfig,
  assignment: Assignment,
  requirementContext: string,
): string {
  const parts = [
    role.prompt_template ?? '',
    '',
    '## 当前任务',
    `**标题：** ${assignment.title}`,
    `**描述：** ${assignment.description}`,
  ]
  if (assignment.acceptance_criteria)
    parts.push(`**验收标准：** ${assignment.acceptance_criteria}`)
  if (requirementContext)
    parts.push('', '## 需求背景', requirementContext)
  parts.push('', '任务完成后，请确保所有修改已提交到当前分支。')
  return parts.join('\n')
}

async function cleanupWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await removeWorktree(repoPath, worktreePath)
  }
  catch {
    // Worktree may already be removed or in inconsistent state — ignore
  }
}
