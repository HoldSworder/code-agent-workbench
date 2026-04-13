import { z } from 'zod'
import type { AgentProvider, PhaseContext, RunOptions } from '../providers/types'
import type { OrchestratorRepository, RequirementForLeader } from './repository'
import type { TeamConfig, LeaderDecision, RoleConfig } from './types'
import { runWorker } from './worker-runner'
import type { WorkerRunnerDeps } from './worker-runner'
import { fetchLarkDocContent } from './lark-fetcher'
import { AgentOutputBuffer } from './output-buffer'

const LeaderDecisionSchema = z.object({
  decision: z.enum(['single_worker', 'split', 'blocked']),
  reason: z.string(),
  assignments: z.array(
    z.object({
      role: z.string(),
      repo_id: z.string().optional(),
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
  outputBuffer?: AgentOutputBuffer
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

  async cancelCurrentProvider(): Promise<void> {
    if (this.currentProvider) {
      await this.currentProvider.cancel()
      this.currentProvider = null
    }
  }

  async dispatchRequirement(requirementId: string): Promise<{ runId: string } | { error: string }> {
    const { repo, teamConfig, repoPath, onChunk } = this.deps
    const req = repo.findRequirementForDispatch(requirementId)
    if (!req) return { error: 'Requirement not found or not in pending state' }
    if (!repo.claimRequirement(req.id)) return { error: 'Failed to claim requirement (concurrent dispatch?)' }

    const run = repo.createRun({
      requirement_id: req.id,
      team_config: JSON.stringify(teamConfig),
    })

    const leaderCwd = this.resolveLeaderCwd()

    repo.appendEvent(run.id, 'leader_started', null, JSON.stringify({ requirement: req.id }))

    this.executeLeader(req, run, leaderCwd).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.deps.onEvent?.('leader_execution_error', { error: errMsg, runId: run.id })
      try {
        repo.updateRunStatus(run.id, 'failed')
        repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({ reason: `Leader 意外错误: ${errMsg}` }))
        repo.updateRequirementStatus(req.id, 'pending')
      }
      catch { /* DB might already be updated inside executeLeader */ }
    })

    return { runId: run.id }
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
    req: RequirementForLeader,
  ): Promise<string | null> {
    const { repo, teamConfig } = this.deps

    const leaderCwd = this.resolveLeaderCwd()

    const run = repo.createRun({
      requirement_id: req.id,
      team_config: JSON.stringify(teamConfig),
    })
    repo.appendEvent(run.id, 'leader_started', null, JSON.stringify({ requirement: req.id }))

    await this.executeLeader(req, run, leaderCwd)
    return run.id
  }

  private resolveLeaderCwd(): string {
    const repos = this.deps.repo.findAllRepos()
    if (repos.length > 0) return repos[0].local_path
    return this.deps.repoPath
  }

  private async executeLeader(
    req: RequirementForLeader,
    run: { id: string },
    leaderCwd: string,
  ): Promise<void> {
    const { repo, teamConfig, resolveProvider, repoPath, defaultBranch, onChunk } = this.deps
    const leaderRole = teamConfig.roles.leader

    // Auto-fetch lark doc content when doc_url exists and content is not yet cached
    let docContent = req.fetch_output ?? ''
    if (req.doc_url && !docContent) {
      this.deps.onEvent?.('doc_fetch_started', { doc_url: req.doc_url })
      const result = await fetchLarkDocContent(req.doc_url)
      if (result.content) {
        docContent = result.content
        repo.updateRequirementFetchOutput(req.id, docContent)
        this.deps.onEvent?.('doc_fetch_completed', { length: docContent.length })
      }
      else {
        this.deps.onEvent?.('doc_fetch_failed', { error: result.error })
      }
    }

    const rejectFeedback = repo.getLastRejectFeedback(req.id)
    const repos = repo.findAllRepos()
    const availableRoles = Object.entries(teamConfig.roles)
      .filter(([id]) => id !== 'leader')
      .map(([id, cfg]) => ({ id, description: cfg.description }))
    const leaderPrompt = buildLeaderPrompt({ role: leaderRole, req, repos, availableRoles, rejectFeedback, docContent })

    const provider = resolveProvider(leaderRole)
    this.currentProvider = provider

    const context: PhaseContext = {
      stageId: 'orchestrator',
      stageName: 'Orchestrator',
      phaseId: 'leader-analyze',
      repoPath: leaderCwd,
      openspecPath: leaderCwd,
      branchName: '',
      skillContent: leaderPrompt,
      requirementTitle: req.title,
      requirementDescription: req.description,
    }

    const { outputBuffer } = this.deps
    const bufferKey = outputBuffer
      ? AgentOutputBuffer.leaderKey(run.id)
      : ''
    const leaderOnChunk = (chunk: string) => {
      onChunk?.(chunk)
      if (outputBuffer) outputBuffer.append(bufferKey, chunk)
    }

    let rawOutput = ''
    let providerFailed = false
    let providerError = ''
    try {
      const result = await provider.run(context, { onChunk: leaderOnChunk })
      rawOutput = result.output ?? ''
      this.currentProvider = null

      if (outputBuffer && rawOutput) {
        const existing = outputBuffer.get(bufferKey)
        if (existing.totalLength === 0) outputBuffer.append(bufferKey, rawOutput)
      }

      if (result.status === 'failed' || result.status === 'cancelled') {
        providerFailed = true
        providerError = result.error ?? 'unknown'
        repo.appendEvent(run.id, 'leader_agent_error', null, JSON.stringify({
          status: result.status,
          error: providerError,
          output: rawOutput.slice(0, 500),
        }))
      }
    }
    catch (err) {
      this.currentProvider = null
      providerFailed = true
      providerError = err instanceof Error ? err.message : String(err)
      repo.appendEvent(run.id, 'leader_agent_error', null, JSON.stringify({ error: providerError }))
      rawOutput = ''
    }

    // If run was cancelled while provider was running, bail out
    const currentRun = repo.findRunById(run.id)
    if (currentRun?.status === 'cancelled') return

    // If provider outright failed, skip parsing retries
    if (providerFailed) {
      repo.updateRunStatus(run.id, 'failed')
      repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
        reason: `Leader agent 运行失败: ${providerError}`,
      }))
      repo.updateRequirementStatus(req.id, 'pending')
      return
    }

    // Parse Leader decision (6D: marker → regex → Zod)
    let decision = parseLeaderDecision(rawOutput)

    if (!decision) {
      repo.appendEvent(run.id, 'leader_output_invalid', null, JSON.stringify({
        output: rawOutput.slice(0, 1000),
        attempt: 1,
      }))

      // Retry once with repair prompt (only when agent ran but output was unparseable)
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
          reason: rawOutput.length === 0
            ? 'Leader agent 返回空输出 — 请检查 agent 命令是否可用以及 API key 配置'
            : 'Leader 输出无法解析为有效 JSON（已重试 2 次）',
        }))
        repo.updateRequirementStatus(req.id, 'pending')
        return
      }
    }

    repo.updateRunLeaderDecision(run.id, JSON.stringify(decision))

    repo.appendEvent(run.id, 'requirement_analyzed', null, JSON.stringify({
      decision: decision.decision,
      reason: decision.reason,
      assignment_count: decision.assignments.length,
    }))

    if (decision.decision === 'blocked') {
      repo.updateRunStatus(run.id, 'blocked')
      repo.appendEvent(run.id, 'run_blocked', null, JSON.stringify({ reason: decision.reason }))
      repo.updateRequirementStatus(req.id, 'pending')
      return
    }

    const assignmentsToCreate = decision.assignments
    if (!assignmentsToCreate.length) {
      repo.updateRunStatus(run.id, 'failed')
      repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
        reason: 'Leader decision had no assignments',
      }))
      repo.updateRequirementStatus(req.id, 'pending')
      return
    }

    const workerRoleIds = Object.keys(teamConfig.roles).filter(k => k !== 'leader')
    const fallbackRoleId = workerRoleIds[0]

    const requirementContextParts = [req.title, '', req.description]
    if (docContent)
      requirementContextParts.push('', '## 需求文档内容', '', docContent)
    const requirementContext = requirementContextParts.join('\n')

    let allSucceeded = true
    for (const assignmentInput of assignmentsToCreate) {
      const runCheck = repo.findRunById(run.id)
      if (runCheck?.status === 'cancelled') return

      let roleId = assignmentInput.role
      let role = teamConfig.roles[roleId]
      if (!role && fallbackRoleId) {
        repo.appendEvent(run.id, 'task_assigned', null, JSON.stringify({
          warning: `Unknown role "${roleId}", falling back to "${fallbackRoleId}"`,
        }))
        roleId = fallbackRoleId
        role = teamConfig.roles[roleId]!
      }
      if (!role) {
        repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
          reason: `Unknown role: ${roleId} (no fallback available)`,
        }))
        allSucceeded = false
        continue
      }

      let targetRepoPath = repoPath
      let targetDefaultBranch = defaultBranch
      if (assignmentInput.repo_id) {
        const targetRepo = repos.find(r => r.id === assignmentInput.repo_id)
          ?? repos.find(r => r.name === assignmentInput.repo_id)
        if (targetRepo) {
          targetRepoPath = targetRepo.local_path
          targetDefaultBranch = targetRepo.default_branch
        }
        else {
          repo.appendEvent(run.id, 'task_assigned', null, JSON.stringify({
            warning: `Unknown repo_id "${assignmentInput.repo_id}", using default repo`,
          }))
        }
      }

      const assignment = repo.createAssignment({
        run_id: run.id,
        role: roleId,
        repo_id: assignmentInput.repo_id,
        title: assignmentInput.title,
        description: assignmentInput.description,
        acceptance_criteria: assignmentInput.acceptance_criteria,
        agent_provider: role.provider,
        agent_model: role.model,
      })
      repo.appendEvent(run.id, 'task_assigned', assignment.id, JSON.stringify({
        role: roleId,
        repo_id: assignmentInput.repo_id,
        title: assignmentInput.title,
      }))

      const workerDeps: WorkerRunnerDeps = {
        repo,
        resolveProvider,
        repoPath: targetRepoPath,
        defaultBranch: targetDefaultBranch,
        outputBuffer: this.deps.outputBuffer,
        onChunk,
      }

      const workerResult = await runWorker(workerDeps, assignment, role, requirementContext)
      if (workerResult.phaseResult.status !== 'success') {
        allSucceeded = false
      }
    }

    if (allSucceeded) {
      repo.updateRunStatus(run.id, 'completed')
      repo.appendEvent(run.id, 'run_completed')
      repo.updateRequirementStatus(req.id, 'pending_acceptance')
    }
    else {
      repo.updateRunStatus(run.id, 'failed')
      repo.appendEvent(run.id, 'run_failed', null, JSON.stringify({
        reason: 'One or more worker assignments failed',
      }))
    }
  }

  private async retryLeaderParsing(
    provider: AgentProvider,
    originalContext: PhaseContext,
    rawOutput: string,
    runId: string,
  ): Promise<LeaderDecision | null> {
    const repairPrompt = `你之前的输出无法解析为有效 JSON。请在回复的最后用 <decision> 标签包裹你的 JSON 决策。

格式示例：

<decision>
{
  "decision": "single_worker",
  "reason": "决策原因",
  "assignments": [
    {
      "role": "角色ID",
      "repo_id": "仓库ID",
      "title": "任务标题",
      "description": "详细描述",
      "acceptance_criteria": "验收标准"
    }
  ]
}
</decision>

你之前的输出片段：
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

interface BuildLeaderPromptInput {
  role: RoleConfig
  req: RequirementForLeader
  repos: Array<{ id: string, name: string, local_path: string, default_branch: string }>
  availableRoles: Array<{ id: string, description: string }>
  rejectFeedback: string | null
  docContent?: string
}

function buildLeaderPrompt({ role, req, repos, availableRoles, rejectFeedback, docContent }: BuildLeaderPromptInput): string {
  const roleIdList = availableRoles.map(r => r.id).join(', ')
  const repoIdList = repos.map(r => r.id).join(', ')

  const parts = [
    role.prompt_template ?? '',
    '',
    '## 工作模式',
    '',
    '你是一个全权自主决策的技术 Leader，负责分析需求并拆分为可独立执行的开发任务。',
    '你可以浏览代码库来了解项目结构和实现细节，但**最终必须输出 `<decision>` JSON 决策**。',
    '',
    '### 决策原则',
    '1. **自主决策** — 根据需求内容、代码库现状和专业判断做出决策，禁止输出交互式提问',
    '2. **仓库路由** — 根据需求涉及的技术栈和代码模块，判断子任务属于哪个仓库',
    '3. **任务粒度** — 每个子任务应当：可独立完成、有明确的验收标准、description 中包含足够上下文（worker 不会看到原始需求文档）',
    '4. **角色匹配** — 根据子任务的技术领域选择最合适的角色',
    '',
    '### 决策类型',
    '- `single_worker`：需求简单明确，只涉及一个仓库/角色，分配一个任务即可',
    '- `split`：需求涉及多个模块/仓库/角色，拆分为多个独立子任务',
    '- `blocked`：需求信息不足或存在外部依赖无法继续，给出阻塞原因',
    '',
    '## 需求信息',
    `**标题：** ${req.title}`,
    `**描述：** ${req.description}`,
  ]

  if (req.source_url) parts.push(`**需求来源：** ${req.source_url}`)
  if (req.doc_url) parts.push(`**需求文档链接：** ${req.doc_url}`)

  if (docContent) {
    parts.push(
      '',
      '## 需求文档详细内容',
      '',
      docContent,
    )
  }

  if (availableRoles.length > 0) {
    parts.push(
      '',
      '## 可分配的角色',
      '',
      '> 你必须且只能从以下角色中选择，禁止使用其他角色名。',
      '',
    )
    for (const r of availableRoles)
      parts.push(`- \`${r.id}\`：${r.description}`)
  }

  if (repos.length > 0) {
    parts.push(
      '',
      '## 可用代码仓库',
      '',
      '> 你可以通过绝对路径浏览以下任意仓库的代码来了解项目结构。',
      '> 你必须根据需求内容判断每个子任务属于哪个仓库，并通过 `repo_id` 字段指定。',
      '> 如果需求涉及多个仓库，请拆分为多个 assignment，每个指向不同的仓库。',
      '',
    )
    for (const repo of repos)
      parts.push(`- ID: \`${repo.id}\`，名称: **${repo.name}**，路径: \`${repo.local_path}\`（默认分支：${repo.default_branch}）`)
  }

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
    '## 输出格式',
    '',
    '分析完成后，用 `<decision>` 标签包裹你的决策 JSON（**只输出 JSON，不要在标签内写其他文字**）：',
    '',
    '```',
    '<decision>',
    '{',
    '  "decision": "single_worker | split | blocked",',
    '  "reason": "决策原因（简述为什么选择此决策类型）",',
    '  "assignments": [',
    '    {',
    `      "role": "${roleIdList || '角色ID'}",`,
    `      "repo_id": "${repoIdList || '仓库ID'}",`,
    '      "title": "子任务标题",',
    '      "description": "详细描述（必须包含完整上下文：要改哪些文件/模块、具体实现思路、相关接口和数据结构）",',
    '      "acceptance_criteria": "验收标准（可验证的具体条件）"',
    '    }',
    '  ]',
    '}',
    '</decision>',
    '```',
    '',
    '### 约束',
    `- \`role\` 必须是：${roleIdList || '（无可用角色）'}`,
    `- \`repo_id\` 必须是：${repoIdList || '（无可用仓库）'}`,
    '- `single_worker` 时 assignments 只有 1 个元素',
    '- `split` 时 assignments 有 2 个或更多元素',
    '- `blocked` 时 assignments 为空数组 `[]`',
    '- 每个 assignment 的 `description` 必须自包含，worker 看不到原始需求文档',
    '',
    '',
    '⚠️ **最终输出要求：浏览代码完成分析后，你必须输出 `<decision>` 标签包裹的 JSON。不输出 `<decision>` 会导致任务失败。禁止只输出分析文本而不给出决策 JSON。**',
  )

  return parts.join('\n')
}
