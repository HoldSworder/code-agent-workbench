import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentProvider, PhaseContext, RunOptions } from '../providers/types'
import { createWorktree, removeWorktree, git } from '../git/operations'
import type { OrchestratorRepository } from './repository'
import type { TeamConfig, LeaderDecision, RoleConfig } from './types'
import { runWorker } from './worker-runner'
import type { WorkerRunnerDeps } from './worker-runner'

const LeaderDecisionSchema = z.object({
  decision: z.enum(['single_worker', 'split', 'blocked']),
  reason: z.string(),
  assignments: z.array(
    z.object({
      role: z.string(),
      title: z.string(),
      description: z.string(),
      acceptance_criteria: z.string().optional(),
    }),
  ),
})

// ── Leader decision parsing (6D: marker → regex → Zod) ──

export function parseLeaderDecision(raw: string): LeaderDecision | null {
  const json = extractByMarker(raw) ?? extractByRegex(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json)
    return LeaderDecisionSchema.parse(parsed)
  }
  catch {
    return null
  }
}

function extractByMarker(text: string): string | null {
  // Try <decision>...</decision> markers
  const tagMatch = text.match(/<decision>([\s\S]*?)<\/decision>/)
  if (tagMatch) return tagMatch[1].trim()

  // Try ```json ... ``` code blocks
  const codeMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (codeMatch) {
    const inner = codeMatch[1].trim()
    if (inner.startsWith('{')) return inner
  }

  return null
}

function extractByRegex(text: string): string | null {
  // Find the outermost { ... } that contains "decision"
  const matches: string[] = []
  let depth = 0
  let start = -1

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i
      depth++
    }
    else if (text[i] === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1)
        if (candidate.includes('"decision"'))
          matches.push(candidate)
        start = -1
      }
    }
  }

  return matches[0] ?? null
}

// ── Leader Loop ──

export interface LeaderLoopDeps {
  repo: OrchestratorRepository
  teamConfig: TeamConfig
  resolveProvider: (role: RoleConfig) => AgentProvider
  repoPath: string
  defaultBranch: string
  onChunk?: RunOptions['onChunk']
  onEvent?: (event: string, data?: unknown) => void
}

export class LeaderLoop {
  private abortController: AbortController | null = null
  private running = false
  private currentProvider: AgentProvider | null = null

  constructor(private deps: LeaderLoopDeps) {}

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.abortController = new AbortController()
    this.scheduleNext(0)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abortController?.abort()
    if (this.currentProvider) {
      await this.currentProvider.cancel()
    }
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return
    const { signal } = this.abortController!

    setTimeout(async () => {
      if (signal.aborted) return

      try {
        const hasMore = await this.poll()
        if (this.running && !signal.aborted)
          this.scheduleNext(hasMore ? 0 : this.deps.teamConfig.polling.interval_seconds * 1000)
      }
      catch (err) {
        this.deps.onEvent?.('poll_error', { error: err instanceof Error ? err.message : String(err) })
        if (this.running && !signal.aborted)
          this.scheduleNext(this.deps.teamConfig.polling.interval_seconds * 1000)
      }
    }, delayMs)
  }

  private async poll(): Promise<boolean> {
    const { repo, teamConfig, repoPath, defaultBranch } = this.deps
    const pending = repo.findPendingOrchestratorRequirements()
    if (pending.length === 0) return false

    const req = pending[0]
    if (!repo.claimRequirement(req.id)) return pending.length > 1

    const runId = await this.processRequirement(req)
    return runId !== null && pending.length > 1
  }

  private async processRequirement(
    req: { id: string, title: string, description: string },
  ): Promise<string | null> {
    const { repo, teamConfig, resolveProvider, repoPath, defaultBranch, onChunk } = this.deps
    const leaderRole = teamConfig.roles.leader

    // Create Leader worktree for code analysis (2B decision)
    const leaderWorktree = join(tmpdir(), `code-agent-leader-${randomUUID().slice(0, 8)}`)
    const leaderBranch = `orchestrator/leader-${randomUUID().slice(0, 6)}`

    try {
      await createWorktree(repoPath, leaderWorktree, leaderBranch, defaultBranch)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      repo.updateRequirementStatus(req.id, 'pending')
      this.deps.onEvent?.('leader_worktree_failed', { error: msg })
      return null
    }

    // Build Leader context
    const rejectFeedback = repo.getLastRejectFeedback(req.id)
    const leaderPrompt = buildLeaderPrompt(leaderRole, req, rejectFeedback)

    const provider = resolveProvider(leaderRole)
    this.currentProvider = provider

    const context: PhaseContext = {
      stageId: 'orchestrator',
      stageName: 'Orchestrator',
      phaseId: 'leader-analyze',
      repoPath: leaderWorktree,
      openspecPath: leaderWorktree,
      branchName: leaderBranch,
      skillContent: leaderPrompt,
      requirementTitle: req.title,
      requirementDescription: req.description,
    }

    const run = repo.createRun({
      requirement_id: req.id,
      team_config: JSON.stringify(teamConfig),
    })
    repo.appendEvent(run.id, 'leader_started', null, JSON.stringify({ requirement: req.id }))

    let rawOutput = ''
    try {
      const result = await provider.run(context, { onChunk })
      rawOutput = result.output ?? ''
      this.currentProvider = null
    }
    catch (err) {
      this.currentProvider = null
      rawOutput = ''
    }

    // Cleanup Leader worktree
    try { await removeWorktree(repoPath, leaderWorktree) } catch {}

    // Parse Leader decision (6D: marker → regex → Zod)
    let decision = parseLeaderDecision(rawOutput)

    if (!decision) {
      repo.appendEvent(run.id, 'leader_output_invalid', null, JSON.stringify({
        output: rawOutput.slice(0, 1000),
        attempt: 1,
      }))

      // Retry once with repair prompt
      const retryResult = await this.retryLeaderParsing(
        provider, context, rawOutput, run.id,
      )
      decision = retryResult

      if (!decision) {
        repo.appendEvent(run.id, 'leader_output_invalid', null, JSON.stringify({
          output: rawOutput.slice(0, 1000),
          attempt: 2,
        }))
        repo.updateRunStatus(run.id, 'failed')
        repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
          reason: 'Leader failed to produce valid JSON after 2 attempts',
        }))
        repo.updateRequirementStatus(req.id, 'pending')
        return null
      }
    }

    repo.updateRunLeaderDecision(run.id, JSON.stringify(decision))

    repo.appendEvent(run.id, 'requirement_analyzed', null, JSON.stringify({
      decision: decision.decision,
      reason: decision.reason,
      assignment_count: decision.assignments.length,
    }))

    // Handle blocked
    if (decision.decision === 'blocked') {
      repo.updateRunStatus(run.id, 'blocked')
      repo.appendEvent(run.id, 'run_blocked', null, JSON.stringify({ reason: decision.reason }))
      repo.updateRequirementStatus(req.id, 'pending')
      return run.id
    }

    // Phase 1: downgrade split to single assignment
    const assignmentsToCreate = decision.decision === 'split'
      ? [decision.assignments[0]]
      : decision.assignments.slice(0, 1)

    if (!assignmentsToCreate.length || !assignmentsToCreate[0]) {
      repo.updateRunStatus(run.id, 'failed')
      repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
        reason: 'Leader decision had no assignments',
      }))
      repo.updateRequirementStatus(req.id, 'pending')
      return null
    }

    const assignmentInput = assignmentsToCreate[0]
    const role = teamConfig.roles[assignmentInput.role]
    if (!role) {
      repo.updateRunStatus(run.id, 'failed')
      repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
        reason: `Unknown role: ${assignmentInput.role}`,
      }))
      repo.updateRequirementStatus(req.id, 'pending')
      return null
    }

    const assignment = repo.createAssignment({
      run_id: run.id,
      role: assignmentInput.role,
      title: assignmentInput.title,
      description: assignmentInput.description,
      acceptance_criteria: assignmentInput.acceptance_criteria,
      agent_provider: role.provider,
      agent_model: role.model,
    })
    repo.appendEvent(run.id, 'task_assigned', assignment.id, JSON.stringify({
      role: assignmentInput.role,
      title: assignmentInput.title,
    }))

    const workerDeps: WorkerRunnerDeps = {
      repo,
      resolveProvider,
      repoPath,
      defaultBranch,
      onChunk,
    }

    const requirementContext = `${req.title}\n\n${req.description}`
    const workerResult = await runWorker(workerDeps, assignment, role, requirementContext)

    if (workerResult.phaseResult.status === 'success') {
      repo.updateRunStatus(run.id, 'completed')
      repo.appendEvent(run.id, 'run_completed')
      repo.updateRequirementStatus(req.id, 'pending_acceptance')
    }
    else {
      repo.updateRunStatus(run.id, 'failed')
      repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
        reason: workerResult.phaseResult.error,
      }))
    }

    return run.id
  }

  private async retryLeaderParsing(
    provider: AgentProvider,
    originalContext: PhaseContext,
    rawOutput: string,
    runId: string,
  ): Promise<LeaderDecision | null> {
    const repairPrompt = `你之前的输出无法解析为有效的 JSON。请重新输出，使用 <decision> 标签包裹：

<decision>
{
  "decision": "single_worker" 或 "split" 或 "blocked",
  "reason": "原因",
  "assignments": [...]
}
</decision>

之前的输出片段：
${rawOutput.slice(0, 500)}`

    const retryContext: PhaseContext = {
      ...originalContext,
      skillContent: repairPrompt,
    }

    try {
      const result = await provider.run(retryContext)
      return parseLeaderDecision(result.output ?? '')
    }
    catch {
      return null
    }
  }
}

function buildLeaderPrompt(
  role: RoleConfig,
  req: { id: string, title: string, description: string },
  rejectFeedback: string | null,
): string {
  const parts = [
    role.prompt_template ?? '',
    '',
    '## 需求信息',
    `**标题：** ${req.title}`,
    `**描述：** ${req.description}`,
  ]

  if (rejectFeedback) {
    parts.push(
      '',
      '## ⚠️ 上次验收被拒绝',
      `**拒绝原因：** ${rejectFeedback}`,
      '请根据拒绝反馈调整你的任务拆分策略。',
    )
  }

  parts.push(
    '',
    '请分析该需求和当前代码库，然后用 <decision> 标签输出你的决策 JSON：',
    '',
    '<decision>',
    '{',
    '  "decision": "single_worker" | "split" | "blocked",',
    '  "reason": "决策原因",',
    '  "assignments": [',
    '    {',
    '      "role": "角色ID（对应 team.yaml 中的角色）",',
    '      "title": "子任务标题",',
    '      "description": "详细描述",',
    '      "acceptance_criteria": "验收标准"',
    '    }',
    '  ]',
    '}',
    '</decision>',
  )

  return parts.join('\n')
}
