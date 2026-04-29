import { errorMessage } from '@code-agent/shared/util'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from '../providers/types'
import { createFeatureBranch, getCurrentBranch, git } from '../git/operations'
import type { OrchestratorRepository } from './repository'
import type { Assignment, RoleConfig } from './types'
import { AgentOutputBuffer } from './output-buffer'

export interface WorkerRunnerDeps {
  repo: OrchestratorRepository
  resolveProvider: (role: RoleConfig) => AgentProvider
  repoPath: string
  defaultBranch: string
  outputBuffer?: AgentOutputBuffer
  onChunk?: RunOptions['onChunk']
}

export interface WorkerResult {
  assignment: Assignment
  phaseResult: PhaseResult
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
  const { repo, resolveProvider, repoPath, defaultBranch, onChunk, outputBuffer } = deps

  const slug = `${slugify(assignment.title)}-${assignment.id.slice(0, 6)}`
  let branchName: string

  repo.updateAssignmentStatus(assignment.id, 'running')
  repo.appendEvent(assignment.run_id, 'worker_started', assignment.id, JSON.stringify({
    role: assignment.role,
  }))

  try {
    branchName = await createFeatureBranch(repoPath, slug, defaultBranch)
  }
  catch (err) {
    const msg = errorMessage(err)
    repo.updateAssignmentStatus(assignment.id, 'failed', `branch creation failed: ${msg}`)
    repo.appendEvent(assignment.run_id, 'worker_failed', assignment.id, JSON.stringify({ error: msg }))
    return {
      assignment: repo.findAssignmentById(assignment.id)!,
      phaseResult: { status: 'failed', error: msg },
    }
  }

  repo.updateAssignmentWorktree(assignment.id, repoPath, branchName)

  const provider = resolveProvider(role)
  const context: PhaseContext = {
    stageId: 'orchestrator',
    stageName: 'Orchestrator',
    phaseId: `worker-${assignment.role}`,
    repoPath,
    openspecPath: repoPath,
    branchName,
    skillContent: buildWorkerPrompt(role, assignment, requirementContext, branchName),
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

  try {
    await git(repoPath, ['checkout', defaultBranch])
  }
  catch {
    // best-effort switch back to base branch
  }

  return {
    assignment: repo.findAssignmentById(assignment.id)!,
    phaseResult,
  }
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
    `你当前在分支 \`${branchName}\` 上工作。`,
    '任务完成后，请确保所有修改已提交到当前分支。',
  )
  return parts.join('\n')
}
