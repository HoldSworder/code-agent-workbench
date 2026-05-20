import { errorMessage } from '@code-agent/shared/util'
import { join } from 'node:path'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from '../providers/types'
import { git, getHead, createWorktree, removeWorktree, mergeNoFf } from '../git/operations'
import type { OrchestratorRepository } from './repository'
import type { Assignment, RoleConfig } from './types'
import { AgentOutputBuffer } from './output-buffer'
import { AssignmentCommitRepository } from '../db/repositories/assignment-commit.repo'
import type Database from 'better-sqlite3'

export interface WorkerRunnerDeps {
  repo: OrchestratorRepository
  resolveProvider: (role: RoleConfig) => AgentProvider
  /** Main repository on-disk path (always the canonical repo root). */
  repoPath: string
  defaultBranch: string
  outputBuffer?: AgentOutputBuffer
  onChunk?: RunOptions['onChunk']
  /**
   * If provided, the worker's branch will be created from the HEAD of this
   * main worktree and, on success, merged back into it. Used by the RepoTask
   * Leader-Worker scenario. When omitted, the worker merges into
   * `defaultBranch` of `repoPath` (legacy orchestrator behaviour).
   */
  mainWorktreePath?: string
  /** When provided, an assignment_commits row is recorded for traceable rollback. */
  repoTaskId?: string
  /** When provided, used as phase_id when recording assignment_commits. */
  phaseId?: string
  /** Optional shared lock for serialising merges to the same main worktree. */
  mergeLock?: AsyncLock
  /** SQLite DB handle, required when repoTaskId is set (for assignment_commits). */
  db?: Database.Database
}

export interface WorkerResult {
  assignment: Assignment
  phaseResult: PhaseResult
  /** When merge succeeded, the merge commit SHA on the target branch. */
  mergeSha?: string
  /** When set, the worker stopped at a merge-conflict state for human/agent recovery. */
  mergeConflict?: boolean
}

/**
 * Minimal async lock for serialising critical sections (e.g. merges into a
 * shared main worktree). Reentrant calls from the same chain are queued, not
 * deadlocked.
 */
export class AsyncLock {
  private chain: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const wait = this.chain
    this.chain = new Promise(res => (release = res))
    await wait
    try { return await fn() }
    finally { release() }
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task'
}

export async function runWorker(
  deps: WorkerRunnerDeps,
  assignment: Assignment,
  role: RoleConfig,
  requirementContext: string,
): Promise<WorkerResult> {
  const {
    repo,
    resolveProvider,
    repoPath,
    defaultBranch,
    onChunk,
    outputBuffer,
    mainWorktreePath,
    repoTaskId,
    phaseId,
    mergeLock,
    db,
  } = deps

  const slug = `${slugify(assignment.title)}-${assignment.id.slice(0, 6)}`
  const targetWorktree = mainWorktreePath ?? repoPath
  const workerBranch = mainWorktreePath
    ? `${await safeCurrentBranch(targetWorktree, defaultBranch)}/w-${assignment.id.slice(0, 8)}`
    : `feature/${slug}`
  const workerWorktreePath = join(repoPath, '.worktrees', `orchestrator-${assignment.id}`)

  repo.updateAssignmentStatus(assignment.id, 'running')
  repo.appendEvent(assignment.run_id, 'worker_started', assignment.id, JSON.stringify({
    role: assignment.role,
    branch: workerBranch,
    worktree: workerWorktreePath,
  }))

  // Lock the base SHA from the merge target before creating worker branch.
  let baseSha: string
  try {
    baseSha = await getHead(targetWorktree)
  }
  catch (err) {
    const msg = errorMessage(err)
    repo.updateAssignmentStatus(assignment.id, 'failed', `resolve base sha failed: ${msg}`)
    repo.appendEvent(assignment.run_id, 'worker_failed', assignment.id, JSON.stringify({ error: msg }))
    return {
      assignment: repo.findAssignmentById(assignment.id)!,
      phaseResult: { status: 'failed', error: msg },
    }
  }

  try {
    await createWorktree(repoPath, workerWorktreePath, workerBranch, baseSha)
  }
  catch (err) {
    const msg = errorMessage(err)
    repo.updateAssignmentStatus(assignment.id, 'failed', `worktree creation failed: ${msg}`)
    repo.appendEvent(assignment.run_id, 'worker_failed', assignment.id, JSON.stringify({ error: msg }))
    return {
      assignment: repo.findAssignmentById(assignment.id)!,
      phaseResult: { status: 'failed', error: msg },
    }
  }

  repo.updateAssignmentWorktree(assignment.id, workerWorktreePath, workerBranch)
  // Record the merge target up-front so conflict recovery can find it even
  // before any assignment_commits row exists.
  repo.setAssignmentMainWorktree(assignment.id, targetWorktree)
  if (repoTaskId) repo.setAssignmentRepoTask(assignment.id, repoTaskId)

  const provider = resolveProvider(role)
  const context: PhaseContext = {
    stageId: 'orchestrator',
    stageName: 'Orchestrator',
    phaseId: phaseId ?? `worker-${assignment.role}`,
    repoPath: workerWorktreePath,
    openspecPath: workerWorktreePath,
    branchName: workerBranch,
    skillContent: buildWorkerPrompt(role, assignment, requirementContext, workerBranch),
    requirementTitle: assignment.title,
    requirementDescription: assignment.description,
  }

  const bufferKey = outputBuffer
    ? AgentOutputBuffer.workerKey(assignment.run_id, assignment.id)
    : ''

  let textLen = 0
  let lastHeartbeatAt = Date.now()
  const HEARTBEAT_INTERVAL_MS = 10_000

  const wrappedOnChunk = (chunk: string) => {
    onChunk?.(chunk)
    if (outputBuffer) outputBuffer.append(bufferKey, chunk)
    textLen += chunk.length
    const now = Date.now()
    if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = now
      repo.appendEvent(assignment.run_id, 'worker_output', assignment.id, JSON.stringify({
        length: textLen,
        tail: chunk.slice(-200),
      }))
    }
  }

  const heartbeatTimer = setInterval(() => {
    repo.appendEvent(assignment.run_id, 'worker_heartbeat', assignment.id, JSON.stringify({
      text_length: textLen,
      elapsed_s: Math.round((Date.now() - lastHeartbeatAt) / 1000),
      status: 'running',
    }))
  }, HEARTBEAT_INTERVAL_MS)

  let phaseResult: PhaseResult
  try {
    phaseResult = await provider.run(context, { onChunk: wrappedOnChunk })
  }
  catch (err) {
    const msg = errorMessage(err)
    phaseResult = { status: 'failed', error: msg }
  }
  finally {
    clearInterval(heartbeatTimer)
  }

  if (outputBuffer && bufferKey) {
    const existing = outputBuffer.get(bufferKey)
    if (existing.totalLength === 0 && phaseResult.output)
      outputBuffer.append(bufferKey, phaseResult.output)
  }

  // Try to merge worker branch back into target on success.
  let mergeSha: string | undefined
  let mergeConflict = false
  if (phaseResult.status === 'success') {
    // Capture worker HEAD before merging (may differ from base if commits made).
    let workerHead = baseSha
    try { workerHead = await getHead(workerWorktreePath) } catch {}

    const doMerge = async (): Promise<void> => {
      const mergeBase = await getHead(targetWorktree).catch(() => baseSha)
      const sha = await mergeNoFf(
        targetWorktree,
        workerBranch,
        `merge worker ${assignment.role} ${assignment.id.slice(0, 8)}`,
      )
      mergeSha = sha
      // Record commit for traceable rollback when we have a RepoTask context.
      if (repoTaskId && db) {
        try {
          new AssignmentCommitRepository(db).upsert({
            assignment_id: assignment.id,
            repo_task_id: repoTaskId,
            phase_id: phaseId ?? `worker-${assignment.role}`,
            branch_name: workerBranch,
            worker_head_sha: workerHead,
            merge_sha: sha,
            base_sha: mergeBase,
          })
        }
        catch { /* best-effort */ }
      }
    }

    try {
      if (mergeLock) await mergeLock.run(doMerge)
      else await doMerge()
    }
    catch (err) {
      mergeConflict = true
      const msg = errorMessage(err)
      // Keep worker worktree around for recovery; mark assignment specifically.
      repo.updateAssignmentStatus(assignment.id, 'merge_conflict', msg)
      repo.appendEvent(assignment.run_id, 'worker_merge_conflict', assignment.id, JSON.stringify({
        error: msg,
        worker_worktree: workerWorktreePath,
        worker_branch: workerBranch,
        main_worktree: targetWorktree,
      }))
      return {
        assignment: repo.findAssignmentById(assignment.id)!,
        phaseResult,
        mergeConflict: true,
      }
    }

    repo.updateAssignmentStatus(assignment.id, 'completed')
    repo.appendEvent(assignment.run_id, 'worker_completed', assignment.id, JSON.stringify({
      output: phaseResult.output?.slice(0, 500),
      merge_sha: mergeSha,
    }))
  }
  else {
    const eventType = phaseResult.error?.includes('timeout') ? 'worker_timeout' : 'worker_failed'
    repo.updateAssignmentStatus(assignment.id, 'failed', phaseResult.error)
    repo.appendEvent(assignment.run_id, eventType, assignment.id, JSON.stringify({
      error: phaseResult.error,
    }))
  }

  // Tear down worker worktree (whether success-merged or plain failed). On
  // merge conflict we already returned above and preserved the worktree.
  await removeWorktree(repoPath, workerWorktreePath).catch(() => {})

  return {
    assignment: repo.findAssignmentById(assignment.id)!,
    phaseResult,
    mergeSha,
    mergeConflict,
  }
}

async function safeCurrentBranch(cwd: string, fallback: string): Promise<string> {
  try {
    const b = await git(cwd, ['branch', '--show-current'])
    return b || fallback
  }
  catch { return fallback }
}

function buildWorkerPrompt(
  role: RoleConfig,
  assignment: Assignment,
  requirementContext: string,
  branchName: string,
): string {
  const parts = [
    role.prompt_template ?? '',
    '',
    '## 工作模式',
    '',
    '你是一个全权自主工作的开发者，不需要征求任何人的意见。',
    '直接根据任务描述和验收标准独立完成工作，做出所有技术决策。',
    '禁止输出任何"是否继续？""请确认""需要你的意见"等交互式提问。',
    '',
    '## 当前任务',
    `**标题：** ${assignment.title}`,
    `**描述：** ${assignment.description}`,
  ]
  if (assignment.acceptance_criteria)
    parts.push(`**验收标准：** ${assignment.acceptance_criteria}`)
  if (requirementContext)
    parts.push('', '## 需求背景', requirementContext)
  parts.push(
    '',
    '## Git 分支',
    `你当前在分支 \`${branchName}\` 上工作（独立 worktree）。`,
    '任务完成后，请确保所有修改已提交到当前分支。',
    '系统会在你完成后自动将该分支合并回主分支并清理 worktree。',
  )
  return parts.join('\n')
}
