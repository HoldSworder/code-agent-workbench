import { existsSync, readdirSync, appendFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'

const LOG_FILE = join(tmpdir(), 'code-agent-engine.log')
function elog(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [engine] ${msg}\n`) } catch {}
}
import type Database from 'better-sqlite3'
import type { AgentProvider, PhaseResult } from '../providers/types'
import { buildPromptFromContext } from '../providers/cli.provider'
import { parseWorkflow, findPhaseById, findPhaseInStages, flattenPhases, getLastMandatoryPhaseId } from './parser'
import type { GateCheck, GateDefinition, PhaseConfig, StageConfig, WorkflowConfig } from './parser'
import { buildPhaseContext } from './context-builder'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { PhaseCommitRepository, INITIAL_PHASE_ID } from '../db/repositories/phase-commit.repo'
import { McpBindingRepository } from '../db/repositories/mcp-binding.repo'
import { McpServerRepository } from '../db/repositories/mcp-server.repo'
import { RepoRepository } from '../db/repositories/repo.repo'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { git, getHead, getMergeBase, resetHard, getCurrentBranch } from '../git/operations'
import { getConfigWriter } from '../mcp/config-writer'
import type { McpServerConfig } from '../mcp/config-writer'

export interface ResolveProviderOptions {
  resumeSessionId?: string
  /** Phase 级别覆盖的 agent 类型（如 cursor-cli / claude-code / codex） */
  agentOverride?: string
  /** Phase 级别覆盖的模型名 */
  modelOverride?: string
}

export interface WorkflowEngineOptions {
  db: Database.Database
  workflowYaml: string
  resolveProvider: (provider: string, options?: ResolveProviderOptions) => AgentProvider
  resolveSkillContent: (skillPath: string) => string
  cliType?: string
}

export class WorkflowEngine {
  private db: Database.Database
  private config: WorkflowConfig
  private resolveProvider: (provider: string, options?: ResolveProviderOptions) => AgentProvider
  private resolveSkillContent: (skillPath: string) => string
  private taskRepo: RepoTaskRepository
  private runRepo: AgentRunRepository
  private msgRepo: MessageRepository
  private reqRepo: RequirementRepository
  private commitRepo: PhaseCommitRepository
  private mcpBindingRepo: McpBindingRepository
  private repoRepo: RepoRepository
  private settingsRepo: SettingsRepository
  private cliType: string
  private mcpServerRepo: McpServerRepository
  private activeProviders = new Map<string, AgentProvider>()
  private liveOutputs = new Map<string, string>()
  private liveActivityLogs = new Map<string, string>()
  private requirementLiveOutputs = new Map<string, string>()
  private activeRequirementProviders = new Map<string, AgentProvider>()
  private activatedPhases = new Map<string, Set<string>>()
  private pendingAdvance = new Set<string>()

  private rawYaml: string
  private configs = new Map<string, WorkflowConfig>()
  private rawYamls = new Map<string, string>()

  constructor(opts: WorkflowEngineOptions) {
    this.db = opts.db
    this.config = parseWorkflow(opts.workflowYaml)
    this.rawYaml = opts.workflowYaml
    this.resolveProvider = opts.resolveProvider
    this.resolveSkillContent = opts.resolveSkillContent
    this.cliType = opts.cliType ?? 'cursor-cli'
    this.taskRepo = new RepoTaskRepository(this.db)
    this.runRepo = new AgentRunRepository(this.db)
    this.msgRepo = new MessageRepository(this.db)
    this.reqRepo = new RequirementRepository(this.db)
    this.commitRepo = new PhaseCommitRepository(this.db)
    this.mcpBindingRepo = new McpBindingRepository(this.db)
    this.mcpServerRepo = new McpServerRepository(this.db)
    this.repoRepo = new RepoRepository(this.db)
    this.settingsRepo = new SettingsRepository(this.db)
  }

  addWorkflow(id: string, yamlContent: string): void {
    const config = parseWorkflow(yamlContent)
    this.configs.set(id, config)
    this.rawYamls.set(id, yamlContent)
  }

  reloadWorkflow(workflowId: string, yamlContent: string): void {
    if (!workflowId || workflowId === 'default') {
      this.config = parseWorkflow(yamlContent)
      this.rawYaml = yamlContent
    }
    else {
      this.configs.set(workflowId, parseWorkflow(yamlContent))
      this.rawYamls.set(workflowId, yamlContent)
    }
  }

  listWorkflows(): { id: string, name: string, description: string }[] {
    if (this.configs.size === 0)
      return [{ id: 'default', name: this.config.name, description: this.config.description ?? '' }]
    const result: { id: string, name: string, description: string }[] = []
    for (const [id, config] of this.configs) {
      result.push({ id, name: config.name, description: config.description ?? '' })
    }
    return result
  }

  getWorkflowConfig(workflowId?: string | null): WorkflowConfig {
    if (!workflowId || workflowId === 'default') return this.config
    return this.configs.get(workflowId) ?? this.config
  }

  private resolveConfigForTask(repoTaskId: string): WorkflowConfig {
    const task = this.taskRepo.findById(repoTaskId)
    return this.getWorkflowConfig(task?.workflow_id)
  }

  recoverMcpBackups(): void {
    const writer = getConfigWriter(this.cliType)
    for (const repo of this.repoRepo.findAll()) {
      if (writer.hasBackup(repo.local_path)) {
        elog(`recoverMcpBackups: restoring backup for ${repo.local_path}`)
        writer.restore(repo.local_path)
      }
    }
    const stuckTasks = this.db.prepare(
      "SELECT id, current_stage, current_phase FROM repo_tasks WHERE phase_status = 'running'",
    ).all() as { id: string, current_stage: string, current_phase: string }[]
    for (const t of stuckTasks) {
      this.taskRepo.updatePhase(t.id, t.current_stage, t.current_phase, 'error')
    }
  }

  // ── 实时输出 ──

  getLiveOutput(repoTaskId: string): string {
    return this.liveOutputs.get(repoTaskId) ?? ''
  }

  getLiveActivity(repoTaskId: string): string {
    return this.liveActivityLogs.get(repoTaskId) ?? ''
  }

  // ── 依赖检查 ──

  checkDependencies(): { ok: boolean, missing: string[] } {
    const missing: string[] = []
    const deps = this.config.dependencies
    if (!deps)
      return { ok: true, missing }

    for (const [name, dep] of Object.entries(deps)) {
      if (dep.type === 'cli' && dep.check) {
        try {
          execSync(dep.check, { stdio: 'pipe' })
        }
        catch {
          missing.push(`${name} (CLI): ${dep.install_hint ?? dep.check}`)
        }
      }
    }
    return { ok: missing.length === 0, missing }
  }

  // ── 状态推断 ──

  inferStageAndPhase(
    worktreePath: string,
    openspecPath: string,
    wfConfig: WorkflowConfig = this.config,
  ): { stageId: string, phaseId: string } {
    const rules = wfConfig.state_inference?.rules
    const fallback = {
      stageId: wfConfig.stages[0].id,
      phaseId: wfConfig.stages[0].phases[0].id,
    }

    if (!rules?.length)
      return fallback

    for (const rule of rules) {
      if (this.evaluateGate(rule.condition, worktreePath, openspecPath, wfConfig))
        return { stageId: rule.stage, phaseId: rule.phase }
    }

    return fallback
  }

  /**
   * 通用门禁求值器：根据 gate_definitions 中的声明式 checks 判断条件是否满足。
   * 所有 checks 之间为 AND 关系，全部通过则条件满足。
   */
  private evaluateGate(
    condition: string,
    worktreePath: string,
    openspecPath: string,
    wfConfig: WorkflowConfig = this.config,
  ): boolean {
    const def = wfConfig.gate_definitions?.[condition]
    if (!def) {
      elog(`evaluateGate: condition "${condition}" not found in gate_definitions, returning false`)
      return false
    }

    const vars: Record<string, string> = {
      openspec_path: openspecPath,
      repo_path: worktreePath,
    }

    for (const check of def.checks) {
      if (!this.evaluateCheck(check, worktreePath, vars))
        return false
    }
    return true
  }

  private resolveTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`)
  }

  private evaluateCheck(check: GateCheck, worktreePath: string, vars: Record<string, string>): boolean {
    try {
      if (check.type === 'command_succeeds') {
        if (!check.command) return false
        const resolved = this.resolveTemplate(check.command, vars)
        execSync(resolved, { cwd: worktreePath, stdio: 'pipe', timeout: 10_000 })
        return true
      }

      if (!check.path) return false
      const absPath = join(worktreePath, this.resolveTemplate(check.path, vars))

      switch (check.type) {
        case 'exists':
          return existsSync(absPath)

        case 'not_exists':
          return !existsSync(absPath)

        case 'file_contains':
          if (!check.pattern || !existsSync(absPath)) return false
          return readFileSync(absPath, 'utf-8').includes(check.pattern)

        case 'file_not_contains':
          if (!check.pattern || !existsSync(absPath)) return false
          return !readFileSync(absPath, 'utf-8').includes(check.pattern)

        case 'file_section_matches': {
          if (!check.pattern || !check.after || !existsSync(absPath)) return false
          const content = readFileSync(absPath, 'utf-8')
          const section = content.split(check.after)[1] ?? ''
          return new RegExp(check.pattern).test(section)
        }

        case 'file_section_not_matches': {
          if (!check.pattern || !check.after || !existsSync(absPath)) return false
          const content = readFileSync(absPath, 'utf-8')
          const section = content.split(check.after)[1] ?? ''
          return !new RegExp(check.pattern).test(section)
        }

        default:
          return false
      }
    }
    catch (err) {
      elog(`evaluateCheck: error checking ${check.type}: ${err}`)
      return false
    }
  }

  resolveGateDescription(condition: string): string | undefined {
    return this.config.gate_definitions?.[condition]?.description
  }

  getGateDefinition(condition: string): GateDefinition | undefined {
    return this.config.gate_definitions?.[condition]
  }

  /**
   * 校验 confirm_files 列表中的文件是否全部存在。
   * 支持 {{openspec_path}} / {{change_id}} 模板变量和单层通配符 `*`。
   * 特殊标记 `__agent_output__` 视为始终通过。
   */
  private validateConfirmFiles(
    patterns: string[],
    worktreePath: string,
    openspecPath: string,
    changeId: string,
  ): string[] {
    const missing: string[] = []
    const vars: Record<string, string> = {
      openspec_path: openspecPath,
      change_id: changeId,
    }

    for (const raw of patterns) {
      if (raw === '__agent_output__') continue

      const resolved = raw.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`)
      const abs = join(worktreePath, resolved)

      if (abs.includes('*')) {
        if (!this.matchSimpleGlob(abs))
          missing.push(resolved)
      }
      else {
        if (!existsSync(abs))
          missing.push(resolved)
      }
    }
    return missing
  }

  private matchSimpleGlob(pattern: string): boolean {
    const starIdx = pattern.indexOf('*')
    if (starIdx === -1) return existsSync(pattern)

    const dir = pattern.slice(0, pattern.lastIndexOf('/', starIdx))
    const suffix = pattern.slice(pattern.indexOf('/', starIdx + 1))

    if (!existsSync(dir)) return false
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      return entries.some((entry) => {
        if (!entry.isDirectory()) return false
        const candidate = join(dir, entry.name, suffix.startsWith('/') ? suffix.slice(1) : suffix)
        return existsSync(candidate)
      })
    }
    catch {
      return false
    }
  }


  // ── Optional phase 激活 ──

  private activatePhase(repoTaskId: string, phaseId: string): void {
    let set = this.activatedPhases.get(repoTaskId)
    if (!set) {
      set = new Set()
      this.activatedPhases.set(repoTaskId, set)
    }
    set.add(phaseId)
  }

  private isPhaseActivated(repoTaskId: string, phaseId: string): boolean {
    if (this.activatedPhases.get(repoTaskId)?.has(phaseId))
      return true
    return this.settingsRepo.get(`phase.${phaseId}.enabled`) === 'true'
  }

  setPhaseEnabled(phaseId: string, enabled: boolean): void {
    this.settingsRepo.set(`phase.${phaseId}.enabled`, enabled ? 'true' : 'false')
  }

  setPhaseAgent(phaseId: string, agent?: string | null, model?: string | null): void {
    if (agent)
      this.settingsRepo.set(`phase.${phaseId}.agent`, agent)
    else
      this.settingsRepo.delete(`phase.${phaseId}.agent`)

    if (model)
      this.settingsRepo.set(`phase.${phaseId}.model`, model)
    else
      this.settingsRepo.delete(`phase.${phaseId}.model`)
  }

  getPhaseAgentConfig(phaseId: string): { agent?: string, model?: string } {
    const agent = this.settingsRepo.get(`phase.${phaseId}.agent`) ?? undefined
    const model = this.settingsRepo.get(`phase.${phaseId}.model`) ?? undefined
    return { agent, model }
  }

  getPhaseAgentMap(workflowId?: string | null): Record<string, { agent?: string, model?: string }> {
    const wf = this.getWorkflowConfig(workflowId)
    const result: Record<string, { agent?: string, model?: string }> = {}
    const collectPhases = (phases: { id: string }[]) => {
      for (const phase of phases) {
        const cfg = this.getPhaseAgentConfig(phase.id)
        if (cfg.agent || cfg.model)
          result[phase.id] = cfg
      }
    }
    for (const stage of wf.stages)
      collectPhases(stage.phases)
    if (wf.requirement_phases)
      collectPhases(wf.requirement_phases)
    return result
  }

  getPhaseEnabledMap(workflowId?: string | null): Record<string, boolean> {
    const wf = this.getWorkflowConfig(workflowId)
    const result: Record<string, boolean> = {}
    for (const stage of wf.stages) {
      for (const phase of stage.phases) {
        if (phase.optional && !phase.triggers?.length && !phase.loopable) {
          const val = this.settingsRepo.get(`phase.${phase.id}.enabled`)
          result[phase.id] = val === 'true'
        }
      }
    }
    return result
  }

  // ── 触发语路由 ──

  routeTrigger(
    userInput: string,
    wfConfig: WorkflowConfig = this.config,
  ): { targetStage: string, targetPhase?: string, strategy?: 'infer_from_state' } | null {
    for (const stage of wfConfig.stages) {
      for (const phase of stage.phases) {
        if (phase.triggers?.some(t => userInput.includes(t)))
          return { targetStage: stage.id, targetPhase: phase.id }
      }
    }

    for (const mapping of wfConfig.trigger_mapping ?? []) {
      if (mapping.patterns.some(p => userInput.includes(p))) {
        if (mapping.strategy === 'infer_from_state')
          return { targetStage: mapping.target_stage, strategy: 'infer_from_state' }
        return { targetStage: mapping.target_stage, targetPhase: mapping.target_phase }
      }
    }

    return null
  }

  // ── 工作流生命周期 ──

  async startWorkflow(repoTaskId: string, workflowId?: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    if (workflowId !== undefined) {
      this.taskRepo.updateWorkflowId(
        repoTaskId,
        !workflowId || workflowId === 'default' ? null : workflowId,
      )
    }

    const taskFresh = this.taskRepo.findById(repoTaskId)!
    const wf = this.resolveConfigForTask(repoTaskId)

    if (!this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)) {
      try {
        const sha = await getMergeBase(taskFresh.worktree_path) ?? await getHead(taskFresh.worktree_path)
        this.commitRepo.save(repoTaskId, INITIAL_PHASE_ID, sha)
      }
      catch { /* non-git worktree, skip */ }
    }

    const { stageId, phaseId } = this.inferStageAndPhase(taskFresh.worktree_path, taskFresh.openspec_path, wf)
    const found = findPhaseInStages(wf.stages, stageId, phaseId)
    const stage = found?.stage ?? wf.stages[0]
    const phase = found?.phase ?? wf.stages[0].phases[0]

    this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'running')
    await this.executePhase(repoTaskId, phase, stage)
  }

  async confirmPhase(repoTaskId: string, options?: { advance?: boolean }): Promise<void> {
    const advance = options?.advance ?? false
    const task = this.taskRepo.findById(repoTaskId)
    elog(`confirmPhase: task=${repoTaskId} stage=${task?.current_stage} phase=${task?.current_phase} status=${task?.phase_status} advance=${advance}`)
    if (!task || !['waiting_confirm', 'waiting_input', 'suspended'].includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a confirmable state (current: ${task?.phase_status})`)

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)
    const { stage, phase } = found

    if (phase.confirm_files?.length) {
      const missing = this.validateConfirmFiles(
        phase.confirm_files,
        task.worktree_path,
        task.openspec_path,
        task.change_id,
      )
      if (missing.length) {
        elog(`confirmPhase: blocked — missing files: ${missing.join(', ')}`)
        const reason = `确认被阻止：以下预期产出文件缺失\n${missing.map(f => `- ${f}`).join('\n')}`
        this.msgRepo.create({
          repo_task_id: repoTaskId,
          phase_id: task.current_phase,
          role: 'assistant',
          content: reason,
        })
        throw new Error(`Confirmation blocked: missing files: ${missing.join(', ')}`)
      }
    }

    if (phase.is_terminal) {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'completed')
      return
    }

    if (!advance) {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_event')
      return
    }

    if (phase.loopable && phase.loop_target) {
      const loopTarget = findPhaseById(wf.stages, phase.loop_target)
      if (loopTarget) {
        this.taskRepo.updatePhase(repoTaskId, loopTarget.stage.id, loopTarget.phase.id, 'running')
        await this.executePhase(repoTaskId, loopTarget.phase, loopTarget.stage)
        return
      }
    }

    const next = this.getNextPhase(repoTaskId, stage.id, phase.id)
    elog(`confirmPhase: next=${next ? `${next.stage.id}/${next.phase.id}` : 'none'}`)
    if (!next) {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_event')
      return
    }

    this.taskRepo.updatePhase(repoTaskId, next.stage.id, next.phase.id, 'running')
    await this.executePhase(repoTaskId, next.phase, next.stage)
  }

  async suspendTask(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`suspendTask: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status}`)
    const allowedStates = ['waiting_confirm', 'waiting_input', 'waiting_event']
    if (!task || !allowedStates.includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a suspendable state (current: ${task?.phase_status})`)

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)

    try {
      const status = await git(task.worktree_path, ['status', '--porcelain'])
      if (status.trim()) {
        await git(task.worktree_path, ['add', '-A'])
        await git(task.worktree_path, ['commit', '-m', `wip: suspend at ${found.phase.name} (${task.current_phase})`])
        elog(`suspendTask: auto-committed WIP changes`)
      }
    }
    catch (err) {
      elog(`suspendTask: git commit failed: ${err}`)
    }

    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: task.current_phase,
      role: 'system',
      content: `需求已挂起，当前进度保存在阶段「${found.phase.name}」。恢复后将从此处继续。`,
    })

    this.taskRepo.updatePhase(repoTaskId, found.stage.id, found.phase.id, 'suspended')
  }

  async resumeTask(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`resumeTask: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status}`)
    if (!task || task.phase_status !== 'suspended')
      throw new Error(`Task ${repoTaskId} is not suspended (current: ${task?.phase_status})`)

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)

    try {
      const currentBranch = (await getCurrentBranch(task.worktree_path)).trim()
      if (currentBranch !== task.branch_name) {
        elog(`resumeTask: branch mismatch current=${currentBranch} target=${task.branch_name}, switching`)
        const status = await git(task.worktree_path, ['status', '--porcelain'])
        if (status.trim()) {
          await git(task.worktree_path, ['stash', 'push', '-m', `auto-stash before resume ${repoTaskId}`])
          elog(`resumeTask: stashed uncommitted changes on branch ${currentBranch}`)
        }
        await git(task.worktree_path, ['checkout', task.branch_name])
        elog(`resumeTask: checked out ${task.branch_name}`)
      }
    }
    catch (err) {
      elog(`resumeTask: branch switch failed: ${err}`)
      throw new Error(`Failed to switch to branch ${task.branch_name}: ${err}`)
    }

    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: task.current_phase,
      role: 'system',
      content: `需求已恢复，当前在阶段「${found.phase.name}」，你可以继续输入联调信息或其他指令。`,
    })

    this.taskRepo.updatePhase(repoTaskId, found.stage.id, found.phase.id, 'waiting_input')
  }

  async provideFeedback(repoTaskId: string, feedback: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`provideFeedback: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status} feedback=${feedback.slice(0, 100)}`)
    const allowedStates = ['waiting_confirm', 'waiting_input', 'suspended', 'failed', 'cancelled']
    if (!task || !allowedStates.includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a feedbackable state (current: ${task?.phase_status})`)

    if (task.current_stage === '_requirements') {
      await this.executeRequirementPhase(repoTaskId, task.current_phase, feedback)
      return
    }

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)
    const { stage, phase } = found

    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: phase.id,
      role: 'user',
      content: feedback,
    })

    this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'running')
    await this.executePhase(repoTaskId, phase, stage, feedback)
  }

  async confirmAndExecute(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`confirmAndExecute: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status}`)
    const allowedStates = ['waiting_confirm', 'waiting_input', 'suspended']
    if (!task || !allowedStates.includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a confirmable state (current: ${task?.phase_status})`)

    if (task.current_stage === '_requirements') {
      await this.executeRequirementPhase(repoTaskId, task.current_phase, '用户已确认，请完成本阶段所有产出。')
      return
    }

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)
    const { stage, phase } = found

    const feedback = '用户已确认，请实施方案并完成本阶段所有产出。'
    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: phase.id,
      role: 'user',
      content: feedback,
    })

    this.pendingAdvance.add(repoTaskId)
    this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'running')
    await this.executePhase(repoTaskId, phase, stage, feedback)
  }

  /**
   * 返回当前 phase 确认后的推进选项：默认下一步 + 可激活的 optional phases。
   * 供前端 confirm card 渲染"跳过联调 / 开始联调"等分支路径。
   */
  getAdvanceOptions(repoTaskId: string): {
    defaultNext: { phaseId: string, phaseName: string, stageId: string } | null
    optionalPhases: { phaseId: string, phaseName: string, stageId: string, entryInput?: { label: string, description?: string, placeholder?: string } }[]
    blocked: boolean
  } {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return { defaultNext: null, optionalPhases: [], blocked: false }

    const wf = this.resolveConfigForTask(repoTaskId)
    const loc = findPhaseInStages(wf.stages, task.current_stage, task.current_phase)
    if (!loc) return { defaultNext: null, optionalPhases: [], blocked: false }

    if (task.phase_status === 'waiting_input' && loc.phase.completion_check) {
      const passed = this.evaluateGate(loc.phase.completion_check, task.worktree_path, task.openspec_path, wf)
      if (!passed) {
        return { defaultNext: null, optionalPhases: [], blocked: true }
      }
    }

    const { stageIdx, phaseIdx } = loc
    const stages = wf.stages
    const currentStage = stages[stageIdx]

    let defaultNext: { phaseId: string, phaseName: string, stageId: string } | null = null
    const optionalPhases: { phaseId: string, phaseName: string, stageId: string, entryInput?: { label: string, description?: string, placeholder?: string } }[] = []

    const collectFromPhases = (phases: PhaseConfig[], startIdx: number, stage: StageConfig) => {
      for (let pi = startIdx; pi < phases.length; pi++) {
        const candidate = phases[pi]
        if (candidate.optional && !this.isPhaseActivated(repoTaskId, candidate.id)) {
          if (candidate.entry_input) {
            optionalPhases.push({
              phaseId: candidate.id,
              phaseName: candidate.name,
              stageId: stage.id,
              entryInput: {
                label: candidate.entry_input.label,
                description: candidate.entry_input.description,
                placeholder: candidate.entry_input.placeholder,
              },
            })
          }
          continue
        }
        if (!defaultNext) {
          defaultNext = { phaseId: candidate.id, phaseName: candidate.name, stageId: stage.id }
        }
        break
      }
    }

    collectFromPhases(currentStage.phases, phaseIdx + 1, currentStage)

    if (!defaultNext && stageIdx < stages.length - 1 && this.checkStageGate(repoTaskId, currentStage.id)) {
      const nextStage = stages[stageIdx + 1]
      collectFromPhases(nextStage.phases, 0, nextStage)
    }

    return { defaultNext, optionalPhases, blocked: false }
  }

  /**
   * 确认当前 phase 并推进到指定的目标 phase（支持激活 optional phase）。
   * 如果提供了 input，作为 user message 写入并传给目标 phase 作为 feedback。
   */
  async confirmAndAdvanceToPhase(repoTaskId: string, targetPhaseId: string, input?: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`confirmAndAdvanceToPhase: task=${repoTaskId} target=${targetPhaseId} phase=${task?.current_phase} status=${task?.phase_status}`)
    const allowedStates = ['waiting_confirm', 'waiting_input', 'suspended']
    if (!task || !allowedStates.includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a confirmable state (current: ${task?.phase_status})`)

    const wf = this.resolveConfigForTask(repoTaskId)

    const currentFound = findPhaseById(wf.stages, task.current_phase)
    if (!currentFound)
      throw new Error(`Current phase ${task.current_phase} not found in workflow config`)

    if (currentFound.phase.confirm_files?.length) {
      const missing = this.validateConfirmFiles(
        currentFound.phase.confirm_files,
        task.worktree_path,
        task.openspec_path,
        task.change_id,
      )
      if (missing.length) {
        const reason = `确认被阻止：以下预期产出文件缺失\n${missing.map(f => `- ${f}`).join('\n')}`
        this.msgRepo.create({
          repo_task_id: repoTaskId,
          phase_id: task.current_phase,
          role: 'assistant',
          content: reason,
        })
        throw new Error(`Confirmation blocked: missing files: ${missing.join(', ')}`)
      }
    }

    const targetFound = findPhaseById(wf.stages, targetPhaseId)
    if (!targetFound)
      throw new Error(`Target phase ${targetPhaseId} not found in workflow config`)

    if (targetFound.phase.optional)
      this.activatePhase(repoTaskId, targetFound.phase.id)

    const feedback = input || `用户已确认，请实施方案并完成本阶段所有产出。`
    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: targetFound.phase.id,
      role: 'user',
      content: feedback,
    })

    this.pendingAdvance.add(repoTaskId)
    this.taskRepo.updatePhase(repoTaskId, targetFound.stage.id, targetFound.phase.id, 'running')
    await this.executePhase(repoTaskId, targetFound.phase, targetFound.stage, feedback)
  }

  async routeAndExecute(repoTaskId: string, userInput: string): Promise<string | null> {
    const wf = this.resolveConfigForTask(repoTaskId)
    const match = this.routeTrigger(userInput, wf)
    if (!match)
      return null

    if (match.strategy === 'infer_from_state') {
      await this.startWorkflow(repoTaskId)
      return 'infer_from_state'
    }

    if (match.targetPhase) {
      const found = findPhaseInStages(wf.stages, match.targetStage, match.targetPhase)
      if (found) {
        if (found.phase.optional)
          this.activatePhase(repoTaskId, found.phase.id)
        this.taskRepo.updatePhase(repoTaskId, found.stage.id, found.phase.id, 'running')
        await this.executePhase(repoTaskId, found.phase, found.stage, userInput)
        return found.phase.id
      }
    }

    const stage = wf.stages.find(s => s.id === match.targetStage)
    if (stage) {
      const phase = stage.phases[0]
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'running')
      await this.executePhase(repoTaskId, phase, stage, userInput)
      return phase.id
    }

    return null
  }

  async retryPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    if (task.phase_status !== 'failed' && task.phase_status !== 'cancelled')
      throw new Error(`Task ${repoTaskId} is not in a retryable state (current: ${task.phase_status})`)

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)

    this.taskRepo.updatePhase(repoTaskId, found.stage.id, found.phase.id, 'running')
    await this.executePhase(repoTaskId, found.phase, found.stage, undefined, { skipEntryGate: true })
  }

  async resetTask(repoTaskId: string): Promise<void> {
    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)
    this.liveActivityLogs.delete(repoTaskId)
    this.activatedPhases.delete(repoTaskId)

    const task = this.taskRepo.findById(repoTaskId)
    if (task) {
      let initialSha = this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
      if (!initialSha) initialSha = await getMergeBase(task.worktree_path)
      if (initialSha) {
        if (!this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID))
          this.commitRepo.save(repoTaskId, INITIAL_PHASE_ID, initialSha)
        try { await resetHard(task.worktree_path, initialSha) }
        catch (e) { process.stderr.write(`[workflow] git reset failed on resetTask: ${e}\n`) }
      }
    }

    this.msgRepo.deleteByTask(repoTaskId)
    this.runRepo.deleteByTask(repoTaskId)
    this.commitRepo.deleteByTask(repoTaskId)
    const wf = this.resolveConfigForTask(repoTaskId)
    const firstStage = wf.stages[0]
    const firstPhase = firstStage.phases[0]
    this.taskRepo.updatePhase(repoTaskId, firstStage.id, firstPhase.id, 'pending')
  }

  async resetCurrentPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)
    elog(`resetCurrentPhase: task=${repoTaskId} current_stage=${task.current_stage} current_phase=${task.current_phase} status=${task.phase_status}`)

    await this.rollbackToPhase(repoTaskId, task.current_stage, task.current_phase)
  }

  async rollbackToPhase(
    repoTaskId: string,
    targetStageId: string,
    targetPhaseId: string,
    options?: { pauseAfterRollback?: boolean },
  ): Promise<void> {
    elog(`rollbackToPhase: task=${repoTaskId} targetStage=${targetStageId} targetPhase=${targetPhaseId} pause=${options?.pauseAfterRollback ?? false}`)
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    const wf = this.resolveConfigForTask(repoTaskId)
    const target = findPhaseInStages(wf.stages, targetStageId, targetPhaseId)
    if (!target)
      throw new Error(`Phase "${targetPhaseId}" not found in stage "${targetStageId}"`)

    const current = findPhaseById(wf.stages, task.current_phase)
    if (current) {
      const targetFlat = target.stageIdx * 10000 + target.phaseIdx
      const currentFlat = current.stageIdx * 10000 + current.phaseIdx
      if (targetFlat > currentFlat)
        throw new Error(`Cannot roll forward: target "${targetStageId}/${targetPhaseId}" is after current "${task.current_stage}/${task.current_phase}"`)
    }

    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)
    this.liveActivityLogs.delete(repoTaskId)

    let resetSha: string | null = null
    if (target.stageIdx === 0 && target.phaseIdx === 0) {
      resetSha = this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
    }
    else {
      const allPhases = flattenPhases(wf)
      const flatIdx = allPhases.findIndex(
        p => p.id === targetPhaseId && p.stageId === targetStageId,
      )
      if (flatIdx > 0)
        resetSha = this.commitRepo.get(repoTaskId, allPhases[flatIdx - 1].id)
      if (!resetSha)
        resetSha = this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
    }

    if (!resetSha) {
      resetSha = await getMergeBase(task.worktree_path)
      if (resetSha) this.commitRepo.save(repoTaskId, INITIAL_PHASE_ID, resetSha)
    }

    if (resetSha) {
      try { await resetHard(task.worktree_path, resetSha) }
      catch (e) { process.stderr.write(`[workflow] git reset failed on rollback: ${e}\n`) }
    }

    const phasesToClear = this.collectPhaseIdsAfter(target.stageIdx, target.phaseIdx, wf)
    this.msgRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)
    this.runRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)
    this.commitRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)

    if (options?.pauseAfterRollback) {
      this.taskRepo.updatePhase(repoTaskId, targetStageId, targetPhaseId, 'waiting_input')
      this.msgRepo.create({
        repo_task_id: repoTaskId,
        phase_id: targetPhaseId,
        role: 'system',
        content: `已回滚到阶段「${target.phase.name}」，等待你的输入后继续。`,
      })
    }
    else {
      this.taskRepo.updatePhase(repoTaskId, targetStageId, targetPhaseId, 'running')
      await this.executePhase(repoTaskId, target.phase, target.stage, undefined, { skipEntryGate: true })
    }
  }

  async rollbackToStage(repoTaskId: string, targetStageId: string, options?: { pauseAfterRollback?: boolean }): Promise<void> {
    const wf = this.resolveConfigForTask(repoTaskId)
    const stage = wf.stages.find(s => s.id === targetStageId)
    if (!stage)
      throw new Error(`Stage "${targetStageId}" not found`)
    await this.rollbackToPhase(repoTaskId, targetStageId, stage.phases[0].id, options)
  }

  async rollbackToMessage(repoTaskId: string, messageId: string): Promise<void> {
    elog(`rollbackToMessage: task=${repoTaskId} messageId=${messageId}`)
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    const msg = this.msgRepo.findById(messageId)
    if (!msg || msg.repo_task_id !== repoTaskId)
      throw new Error(`Message not found or does not belong to task: ${messageId}`)

    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)
    this.liveActivityLogs.delete(repoTaskId)

    this.msgRepo.deleteAfterMessage(repoTaskId, msg.phase_id, msg.created_at)
    this.runRepo.deleteByTaskPhaseAfterTime(repoTaskId, msg.phase_id, msg.created_at)

    const wf = this.resolveConfigForTask(repoTaskId)
    const found = findPhaseById(wf.stages, msg.phase_id)
    const phaseName = found?.phase.name ?? msg.phase_id

    if (found) {
      const laterPhases = this.collectPhaseIdsAfter(
        found.stageIdx, found.phaseIdx + 1, wf,
      )
      if (laterPhases.length) {
        this.msgRepo.deleteByTaskAndPhases(repoTaskId, laterPhases)
        this.runRepo.deleteByTaskAndPhases(repoTaskId, laterPhases)
        this.commitRepo.deleteByTaskAndPhases(repoTaskId, laterPhases)
      }
    }

    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: msg.phase_id,
      role: 'system',
      content: `已回退到指定消息，阶段「${phaseName}」等待你的输入后继续。`,
    })

    const stageId = found?.stage.id ?? task.current_stage
    this.taskRepo.updatePhase(repoTaskId, stageId, msg.phase_id, 'waiting_input')
  }

  getFullConfig(): WorkflowConfig {
    return this.config
  }

  getRawYaml(workflowId?: string | null): string {
    if (!workflowId || workflowId === 'default') return this.rawYaml
    return this.rawYamls.get(workflowId) ?? this.rawYaml
  }

  reloadConfig(yamlContent: string): void {
    this.config = parseWorkflow(yamlContent)
    this.rawYaml = yamlContent
  }

  resolveSkill(skillPath: string): string {
    return this.resolveSkillContent(skillPath)
  }

  getStagesAndPhases(workflowId?: string | null): { id: string, name: string, gate?: string, stageGatePhaseId?: string, phases: { id: string, name: string, suspendable?: boolean, carriesStageGate?: boolean, optional?: boolean, entryInput?: { label: string, description?: string, placeholder?: string } }[] }[] {
    const wf = this.getWorkflowConfig(workflowId)
    return wf.stages.map((s) => {
      const gatePhaseId = s.gate ? getLastMandatoryPhaseId(s) : undefined
      return {
        id: s.id,
        name: s.name,
        gate: s.gate,
        stageGatePhaseId: gatePhaseId,
        phases: s.phases.map(p => ({
          id: p.id,
          name: p.name,
          suspendable: p.suspendable || undefined,
          carriesStageGate: gatePhaseId === p.id || undefined,
          optional: p.optional || undefined,
          entryInput: p.entry_input ? { label: p.entry_input.label, description: p.entry_input.description, placeholder: p.entry_input.placeholder } : undefined,
        })),
      }
    })
  }

  getRequirementPhases(): { id: string, name: string, optional?: boolean, skippable?: boolean }[] {
    return (this.config.requirement_phases ?? []).map(p => ({
      id: p.id,
      name: p.name,
      optional: p.optional,
      skippable: p.skippable,
    }))
  }

  // ── Requirement-level fetch (no task required) ──

  getRequirementLiveOutput(requirementId: string): string {
    const live = this.requirementLiveOutputs.get(requirementId)
    if (live !== undefined) return live
    const req = this.reqRepo.findById(requirementId)
    return req?.fetch_output ?? ''
  }

  async startRequirementFetch(requirementId: string, mcpServerIds?: string[]): Promise<void> {
    const requirement = this.reqRepo.findById(requirementId)
    if (!requirement)
      throw new Error(`Requirement not found: ${requirementId}`)
    if (requirement.source !== 'feishu' || !requirement.source_url)
      throw new Error(`Requirement ${requirementId} is not a feishu requirement or has no source_url`)

    const reqPhases = this.config.requirement_phases ?? []
    const phase = reqPhases.find(p => p.id === 'feishu-requirement')
    if (!phase)
      throw new Error('feishu-requirement phase not found in workflow config')

    // status 已由 RPC 层同步设置为 fetching，此处确保 liveOutput 初始化
    this.requirementLiveOutputs.set(requirementId, '')

    const baseDir = join(homedir(), '.code-agent', 'requirement-fetch')
    const workDir = join(baseDir, requirementId)
    try { mkdirSync(workDir, { recursive: true }) } catch {}

    const phaseAgentCfg = this.getPhaseAgentConfig(phase.id)
    const effectiveCliType = phaseAgentCfg.agent ?? this.cliType
    const configWriter = getConfigWriter(effectiveCliType)

    try {
      if (mcpServerIds?.length) {
        const servers = mcpServerIds
          .map(id => this.mcpServerRepo.findById(id))
          .filter((s): s is NonNullable<typeof s> => !!s)

        if (servers.length > 0) {
          const serverConfigs: McpServerConfig[] = servers.map(s => ({
            name: s.name,
            transport: s.transport,
            command: s.command,
            args: JSON.parse(s.args),
            env: JSON.parse(s.env),
            url: s.url,
            headers: JSON.parse(s.headers),
          }))
          configWriter.write(workDir, serverConfigs)
          const mcpConfigPath = configWriter.getConfigPath(workDir)
          elog(`startRequirementFetch: injected ${servers.length} MCP server(s) for requirement ${requirementId} (cliType=${effectiveCliType}, configPath=${mcpConfigPath}, servers=${servers.map(s => s.name).join(',')})`)
        }
      }

      const reqInfo = {
        title: requirement.title,
        description: requirement.description,
        sourceUrl: requirement.source_url ?? undefined,
        docUrl: requirement.doc_url ?? undefined,
      }

      const context = buildPhaseContext(
        phase,
        '_requirements',
        '需求收集',
        workDir,
        '',
        '',
        '',
        {
          resolveSkillContent: this.resolveSkillContent,
          externalRules: this.config.external_rules,
          resolveRuleContent: this.resolveSkillContent,
        },
        undefined,
        undefined,
        false,
        reqInfo,
        undefined,
      )
      const provider = this.resolveProvider(phase.provider, {
        agentOverride: phaseAgentCfg.agent,
        modelOverride: phaseAgentCfg.model,
      })
      this.activeRequirementProviders.set(requirementId, provider)

      const promptText = buildPromptFromContext(context, effectiveCliType !== 'codex')
      this.reqRepo.updateFetchMeta(requirementId, {
        prompt: promptText,
        cliType: effectiveCliType,
        model: provider.model ?? null,
      })

      const result = await provider.run(context, {
        onChunk: (chunk) => {
          const current = this.requirementLiveOutputs.get(requirementId) ?? ''
          this.requirementLiveOutputs.set(requirementId, current + chunk)
        },
      })

      this.activeRequirementProviders.delete(requirementId)

      const fullOutput = this.requirementLiveOutputs.get(requirementId) ?? result.output ?? ''
      this.reqRepo.updateFetchOutput(requirementId, fullOutput || null)

      if (result.status === 'failed' || result.status === 'cancelled') {
        this.reqRepo.updateFetchError(requirementId, result.error ?? `Agent ${result.status}`)
        this.reqRepo.updateStatus(requirementId, 'fetch_failed')
        elog(`startRequirementFetch: failed for ${requirementId}: ${result.error}`)
        return
      }

      elog(`startRequirementFetch: fullOutput length=${fullOutput.length}, hasJSON=${fullOutput.includes('REQUIREMENT_DATA_JSON')}, hasYAML=${fullOutput.includes('REQUIREMENT_DATA')}`)
      if (fullOutput) {
        const parsed = this.parseRequirementDataBlock(fullOutput)
        elog(`startRequirementFetch: parsed=${JSON.stringify(parsed)}`)
        if (parsed) {
          const updateData: { title?: string, description?: string, doc_url?: string | null } = {}
          if (parsed.title) updateData.title = parsed.title
          if (parsed.description) updateData.description = parsed.description
          if (parsed.doc_url) updateData.doc_url = parsed.doc_url
          elog(`startRequirementFetch: updateData=${JSON.stringify(updateData)}`)
          if (Object.keys(updateData).length > 0) {
            this.reqRepo.update(requirementId, updateData)
            elog(`startRequirementFetch: updated requirement ${requirementId} with ${JSON.stringify(Object.keys(updateData))}`)
          }
        }
      }

      const finalReq = this.reqRepo.findById(requirementId)
      const targetStatus = finalReq?.mode === 'orchestrator' ? 'pending' : 'draft'
      this.reqRepo.updateStatus(requirementId, targetStatus)
      elog(`startRequirementFetch: completed for ${requirementId}, status → ${targetStatus}`)
    }
    catch (err: unknown) {
      this.activeRequirementProviders.delete(requirementId)
      const errMsg = err instanceof Error ? err.message : String(err)
      this.reqRepo.updateFetchError(requirementId, errMsg)
      this.reqRepo.updateStatus(requirementId, 'fetch_failed')
      elog(`startRequirementFetch: crashed for ${requirementId}: ${errMsg}`)
    }
    finally {
      this.requirementLiveOutputs.delete(requirementId)
    }
  }

  async cancelRequirementFetch(requirementId: string): Promise<void> {
    const provider = this.activeRequirementProviders.get(requirementId)
    if (provider) {
      await provider.cancel()
      this.activeRequirementProviders.delete(requirementId)
    }
    this.requirementLiveOutputs.delete(requirementId)
    const req = this.reqRepo.findById(requirementId)
    if (req && req.status === 'fetching') {
      this.reqRepo.updateStatus(requirementId, 'fetch_failed')
      this.reqRepo.updateFetchError(requirementId, '用户取消')
    }
  }

  async executeRequirementPhase(
    repoTaskId: string,
    phaseId: string,
    userMessage?: string,
  ): Promise<void> {
    const reqPhases = this.config.requirement_phases ?? []
    const phase = reqPhases.find(p => p.id === phaseId)
    if (!phase)
      throw new Error(`Requirement phase "${phaseId}" not found`)

    const virtualStage: StageConfig = { id: '_requirements', name: '需求收集', phases: reqPhases }
    this.taskRepo.updatePhase(repoTaskId, '_requirements', phaseId, 'running')
    await this.executePhase(repoTaskId, phase, virtualStage, userMessage)

    const task = this.taskRepo.findById(repoTaskId)
    if (task && task.current_stage === '_requirements') {
      this.extractAndSaveRequirementData(repoTaskId, phaseId)

      const interactiveStatuses = ['waiting_input', 'waiting_confirm']
      if (!interactiveStatuses.includes(task.phase_status)) {
        this.taskRepo.updatePhase(repoTaskId, 'planning', 'task-breakdown', 'pending')
      }
    }
  }

  /**
   * 从需求获取阶段的 agent 输出中提取 <<REQUIREMENT_DATA>> 标记块，
   * 解析 title / description / doc_url 并回写到 requirement 记录。
   */
  private extractAndSaveRequirementData(repoTaskId: string, phaseId: string): void {
    const messages = this.msgRepo.findByTaskAndPhase(repoTaskId, phaseId)
    const assistantMsg = messages.filter(m => m.role === 'assistant').pop()
    if (!assistantMsg) return

    const parsed = this.parseRequirementDataBlock(assistantMsg.content)
    if (!parsed) return

    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return

    const updateData: { title?: string, description?: string, doc_url?: string | null } = {}
    if (parsed.title) updateData.title = parsed.title
    if (parsed.description) updateData.description = parsed.description
    if (parsed.doc_url) updateData.doc_url = parsed.doc_url

    if (Object.keys(updateData).length > 0) {
      this.reqRepo.update(task.requirement_id, updateData)
      elog(`extractAndSaveRequirementData: updated requirement ${task.requirement_id} with ${JSON.stringify(Object.keys(updateData))}`)
    }
  }

  /**
   * 解析 agent 输出中的结构化数据块。
   * 优先匹配 JSON 格式（<<REQUIREMENT_DATA_JSON>>），回退到旧 YAML 格式（<<REQUIREMENT_DATA>>）。
   */
  private parseRequirementDataBlock(output: string): { title?: string, description?: string, doc_url?: string } | null {
    // JSON 格式（推荐）
    const jsonMatch = output.match(/<<REQUIREMENT_DATA_JSON>>([\s\S]*?)<<END_REQUIREMENT_DATA_JSON>>/)
    if (jsonMatch) {
      try {
        const raw = jsonMatch[1].trim()
        elog(`parseRequirementDataBlock: JSON raw (${raw.length} chars): ${raw.slice(0, 500)}`)
        const data = JSON.parse(raw) as Record<string, unknown>
        elog(`parseRequirementDataBlock: JSON parsed keys=${Object.keys(data)}, doc_url=${JSON.stringify(data.doc_url)}`)
        const result: { title?: string, description?: string, doc_url?: string } = {}
        if (typeof data.title === 'string' && data.title) result.title = data.title
        if (typeof data.doc_url === 'string' && data.doc_url) result.doc_url = data.doc_url
        if (typeof data.description === 'string' && data.description) result.description = data.description
        return Object.keys(result).length > 0 ? result : null
      }
      catch (e) {
        elog(`parseRequirementDataBlock: JSON parse failed: ${e}, falling back to YAML`)
      }
    }

    // 旧 YAML 格式（向后兼容）
    const yamlMatch = output.match(/<<REQUIREMENT_DATA>>([\s\S]*?)<<END_REQUIREMENT_DATA>>/)
    if (!yamlMatch) return null

    const block = yamlMatch[1]
    const result: { title?: string, description?: string, doc_url?: string } = {}

    const titleMatch = block.match(/^title:\s*(.+)$/m)
    if (titleMatch) result.title = titleMatch[1].trim()

    const docUrlMatch = block.match(/^doc_url:\s*(.+)$/m)
      ?? block.match(/^doc_url:\s*\n\s*(https?:\/\/\S+)/m)
    if (docUrlMatch) result.doc_url = docUrlMatch[1].trim()

    const descMatch = block.match(/^description:\s*\|\s*\n([\s\S]*?)(?=\n\S|\n*$)/)
    if (descMatch) {
      result.description = descMatch[1].replace(/^ {2}/gm, '').trim()
    }
    else {
      const simpleDescMatch = block.match(/^description:\s*(.+)$/m)
      if (simpleDescMatch) result.description = simpleDescMatch[1].trim()
    }

    return Object.keys(result).length > 0 ? result : null
  }

  async cancelCurrentAgent(repoTaskId: string): Promise<void> {
    const provider = this.activeProviders.get(repoTaskId)
    if (provider) {
      await provider.cancel()
      this.activeProviders.delete(repoTaskId)
    }

    const task = this.taskRepo.findById(repoTaskId)
    if (task)
      this.taskRepo.updatePhase(repoTaskId, task.current_stage, task.current_phase, 'cancelled')
  }

  /**
   * 无需 taskId，用占位变量生成某个 phase 的提示词模板。
   * 用于工作流编辑器中预览 "Agent 大概会收到什么 prompt"。
   */
  previewPhasePromptTemplate(phaseId: string, workflowId?: string | null): string {
    const wf = this.getWorkflowConfig(workflowId)
    const reqPhases = this.config.requirement_phases ?? []
    const found = findPhaseById(wf.stages, phaseId)
      ?? reqPhases.map((p) => {
        if (p.id !== phaseId) return null
        const virtualStage = { id: '_requirements', name: '需求收集', phases: reqPhases }
        return { stage: virtualStage, phase: p, stageIdx: -1, phaseIdx: 0 }
      }).find(Boolean)

    if (!found) throw new Error(`Phase ${phaseId} not found in workflow config`)
    const { stage, phase } = found

    const placeholders = {
      repoPath: '/path/to/repo',
      openspecPath: 'openspec/changes/<change-id>',
      branchName: 'feature/<change-id>',
      changeId: '<change-id>',
    }

    const ctxDeps = {
      resolveSkillContent: this.resolveSkillContent,
      guardrailDefinitions: wf.guardrail_definitions,
      gateDefinitions: wf.gate_definitions,
      externalRules: wf.external_rules,
      resolveRuleContent: this.resolveSkillContent,
    }

    const stageTyped = stage as StageConfig
    const shouldInjectGate = stageTyped.gate
      && getLastMandatoryPhaseId(stageTyped) === phase.id
    const effectiveGate = shouldInjectGate ? stageTyped.gate : undefined

    const context = buildPhaseContext(
      phase,
      stage.id,
      stage.name,
      placeholders.repoPath,
      placeholders.openspecPath,
      placeholders.branchName,
      placeholders.changeId,
      ctxDeps,
      undefined,
      undefined,
      false,
      { title: '<需求标题>', description: '<需求描述>', docUrl: '<飞书文档URL>', sourceUrl: '<飞书项目链接>' },
      effectiveGate,
    )

    const canReadFiles = this.cliType === 'cursor-cli' || this.cliType === 'claude-code'
    return buildPromptFromContext(context, canReadFiles)
  }

  /**
   * 预览某个 phase 被调用时发送给 CLI 的完整提示词（不执行）。
   * 用于在前端 UI 中展示 "Agent 会收到什么 prompt"。
   */
  previewPhasePrompt(repoTaskId: string, phaseId: string): string {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)

    const wf = this.resolveConfigForTask(repoTaskId)
    const reqPhases = this.config.requirement_phases ?? []
    const found = findPhaseById(wf.stages, phaseId)
      ?? reqPhases.map((p, i) => {
        if (p.id !== phaseId) return null
        const virtualStage = { id: '_requirements', name: '需求收集', phases: reqPhases }
        return { stage: virtualStage, phase: p, stageIdx: -1, phaseIdx: i }
      }).find(Boolean)

    if (!found) throw new Error(`Phase ${phaseId} not found in workflow config`)
    const { stage, phase } = found

    const requirement = this.reqRepo.findById(task.requirement_id)

    const history = this.msgRepo
      .findByTaskAndPhase(repoTaskId, phase.id)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const reqInfo = requirement
      ? { title: requirement.title, description: requirement.description, docUrl: requirement.doc_url ?? undefined, sourceUrl: requirement.source_url ?? undefined }
      : undefined

    const ctxDeps = {
      resolveSkillContent: this.resolveSkillContent,
      guardrailDefinitions: wf.guardrail_definitions,
      gateDefinitions: wf.gate_definitions,
      externalRules: wf.external_rules,
      resolveRuleContent: this.resolveSkillContent,
    }

    const stageTyped = stage as StageConfig
    const shouldInjectGate = stageTyped.gate
      && getLastMandatoryPhaseId(stageTyped) === phase.id
    const effectiveGate = shouldInjectGate ? stageTyped.gate : undefined

    const context = buildPhaseContext(
      phase,
      stage.id,
      stage.name,
      task.worktree_path,
      task.openspec_path,
      task.branch_name,
      task.change_id,
      ctxDeps,
      undefined,
      history.length > 0 ? history : undefined,
      false,
      reqInfo,
      effectiveGate,
    )

    const canReadFiles = this.cliType === 'cursor-cli' || this.cliType === 'claude-code'
    return buildPromptFromContext(context, canReadFiles)
  }

  // ── 内部执行 ──

  private async executePhase(
    repoTaskId: string,
    phase: PhaseConfig,
    stage: StageConfig,
    userMessage?: string,
    options?: { skipEntryGate?: boolean },
  ): Promise<void> {
    elog(`executePhase: task=${repoTaskId} stage=${stage.id} phase=${phase.id} provider=${phase.provider} hasUserMsg=${!!userMessage} skipEntryGate=${options?.skipEntryGate ?? false}`)
    let agentRunId: string | null = null

    try {
      const task = this.taskRepo.findById(repoTaskId)!
      const wf = this.resolveConfigForTask(repoTaskId)

      if (phase.entry_gate && !options?.skipEntryGate) {
        const gatePassed = this.evaluateGate(
          phase.entry_gate,
          task.worktree_path,
          task.openspec_path,
          wf,
        )
        if (!gatePassed) {
          elog(`executePhase: entry_gate "${phase.entry_gate}" BLOCKED for phase ${phase.id}`)
          const reason = `阶段「${phase.name}」的入口门禁「${phase.entry_gate}」未通过，前置产出缺失。请确认上一阶段已正确完成。`
          this.msgRepo.create({
            repo_task_id: repoTaskId,
            phase_id: phase.id,
            role: 'assistant',
            content: reason,
          })
          this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'failed')
          return
        }
      }

      const requirement = this.reqRepo.findById(task.requirement_id)

      const previousSessionId = this.runRepo.findLastSessionId(repoTaskId, phase.id)
      const isResume = !!previousSessionId && !!userMessage

      const history = this.msgRepo
        .findByTaskAndPhase(repoTaskId, phase.id)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const reqInfo = requirement
        ? { title: requirement.title, description: requirement.description, docUrl: requirement.doc_url ?? undefined, sourceUrl: requirement.source_url ?? undefined }
        : undefined

      const ctxDeps = {
        resolveSkillContent: this.resolveSkillContent,
        guardrailDefinitions: wf.guardrail_definitions,
        gateDefinitions: wf.gate_definitions,
        externalRules: wf.external_rules,
        resolveRuleContent: this.resolveSkillContent,
      }

      const shouldInjectStageGate = stage.gate
        && getLastMandatoryPhaseId(stage) === phase.id
      const effectiveStageGate = shouldInjectStageGate ? stage.gate : undefined

      const context = isResume
        ? buildPhaseContext(
            phase,
            stage.id,
            stage.name,
            task.worktree_path,
            task.openspec_path,
            task.branch_name,
            task.change_id,
            ctxDeps,
            userMessage,
            undefined,
            true,
            reqInfo,
            effectiveStageGate,
          )
        : buildPhaseContext(
            phase,
            stage.id,
            stage.name,
            task.worktree_path,
            task.openspec_path,
            task.branch_name,
            task.change_id,
            ctxDeps,
            userMessage,
            history.length > 0 ? history : undefined,
            false,
            reqInfo,
            effectiveStageGate,
          )

      const phaseAgentCfg = this.getPhaseAgentConfig(phase.id)
      const provider = this.resolveProvider(phase.provider, {
        resumeSessionId: previousSessionId ?? undefined,
        agentOverride: phaseAgentCfg.agent,
        modelOverride: phaseAgentCfg.model,
      })

      const actualAgent = phaseAgentCfg.agent ?? this.settingsRepo.get('agent.provider') ?? phase.provider
      const agentRun = this.runRepo.create({
        repo_task_id: repoTaskId,
        phase_id: phase.id,
        provider: actualAgent,
      })
      agentRunId = agentRun.id
      this.activeProviders.set(repoTaskId, provider)
      this.liveOutputs.set(repoTaskId, '')
      this.liveActivityLogs.set(repoTaskId, '')

      const effectiveCliType = phaseAgentCfg.agent ?? this.settingsRepo.get('agent.provider') ?? this.cliType
      const canReadFiles = effectiveCliType === 'cursor-cli' || effectiveCliType === 'claude-code'
      const promptText = isResume && context.userMessage
        ? context.userMessage
        : buildPromptFromContext(context, canReadFiles)
      this.msgRepo.create({
        repo_task_id: repoTaskId,
        phase_id: phase.id,
        role: 'prompt',
        content: promptText,
      })

      let mcpServers = this.mcpBindingRepo.resolveServersForPhase(stage.id, phase.id)

      // Fallback: resolve from YAML mcp_servers declaration when no DB bindings exist
      if (mcpServers.length === 0 && phase.mcp_servers?.length) {
        mcpServers = phase.mcp_servers
          .map(name => this.mcpServerRepo.findByName(name))
          .filter((s): s is NonNullable<typeof s> => !!s && s.enabled === 1)
        if (mcpServers.length > 0)
          elog(`executePhase: resolved ${mcpServers.length} MCP server(s) from YAML mcp_servers for ${stage.id}/${phase.id}`)
      }

      const configWriter = getConfigWriter(effectiveCliType)
      const cwd = task.worktree_path

      if (mcpServers.length === 0) {
        elog(`executePhase: no MCP servers for ${stage.id}/${phase.id}`)
      } else {
        const serverConfigs: McpServerConfig[] = mcpServers.map(s => ({
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: JSON.parse(s.args),
          env: JSON.parse(s.env),
          url: s.url,
          headers: JSON.parse(s.headers),
        }))
        configWriter.backup(cwd)
        configWriter.write(cwd, serverConfigs)
        const mcpConfigPath = configWriter.getConfigPath(cwd)
        elog(`executePhase: injected ${mcpServers.length} MCP server(s) for ${stage.id}/${phase.id} (cliType=${effectiveCliType}, configPath=${mcpConfigPath}, servers=${mcpServers.map(s => s.name).join(',')})`)
      }

      const MAX_ACTIVITY_SIZE = 50 * 1024
      let result: PhaseResult
      try {
        result = await provider.run(context, {
          onChunk: (chunk) => {
            const current = this.liveOutputs.get(repoTaskId) ?? ''
            this.liveOutputs.set(repoTaskId, current + chunk)
          },
          onActivity: (entry) => {
            let current = this.liveActivityLogs.get(repoTaskId) ?? ''
            current += entry
            if (current.length > MAX_ACTIVITY_SIZE)
              current = current.slice(-MAX_ACTIVITY_SIZE)
            this.liveActivityLogs.set(repoTaskId, current)
          },
        })
      } finally {
        if (mcpServers.length > 0) {
          configWriter.restore(cwd)
          elog(`executePhase: restored MCP config for ${stage.id}/${phase.id}`)
        }
      }
      this.activeProviders.delete(repoTaskId)

      const sessionId = (provider as any).sessionId ?? undefined
      const modelUsed = provider.model ?? undefined
      this.runRepo.finish(agentRun.id, result.status, result.tokenUsage, result.error, sessionId, modelUsed)

      if (result.output) {
        this.msgRepo.create({
          repo_task_id: repoTaskId,
          phase_id: phase.id,
          role: 'assistant',
          content: this.stripPhaseSignals(result.output),
        })
      }

      setTimeout(() => {
        this.liveOutputs.delete(repoTaskId)
        this.liveActivityLogs.delete(repoTaskId)
      }, 2000)

      await this.handlePhaseResult(repoTaskId, phase, stage, result)
    }
    catch (err: unknown) {
      this.activeProviders.delete(repoTaskId)
      this.liveOutputs.delete(repoTaskId)
      this.liveActivityLogs.delete(repoTaskId)
      const errMsg = err instanceof Error ? err.message : String(err)

      if (agentRunId)
        this.runRepo.finish(agentRunId, 'failed', undefined, errMsg)

      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'failed')
      process.stderr.write(`[workflow] executePhase crashed for ${repoTaskId}/${stage.id}/${phase.id}: ${errMsg}\n`)
    }
  }

  private async handlePhaseResult(
    repoTaskId: string,
    phase: PhaseConfig,
    stage: StageConfig,
    result: PhaseResult,
  ): Promise<void> {
    const wf = this.resolveConfigForTask(repoTaskId)
    const agentSignal = this.parsePhaseSignal(result.output)
    const shouldAutoAdvance = this.pendingAdvance.has(repoTaskId)
    if (shouldAutoAdvance) this.pendingAdvance.delete(repoTaskId)
    elog(`handlePhaseResult: stage=${stage.id} phase=${phase.id} status=${result.status} agentSignal=${agentSignal} requires_confirm=${phase.requires_confirm} completion_check=${phase.completion_check ?? 'none'} autoAdvance=${shouldAutoAdvance} error=${result.error?.slice(0, 200) ?? 'none'}`)

    if (result.status === 'failed' || result.status === 'cancelled') {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, result.status)
      return
    }

    if (result.status === 'pending_input' || agentSignal === 'pending_input') {
      if (!shouldAutoAdvance) {
        this.msgRepo.create({
          repo_task_id: repoTaskId,
          phase_id: phase.id,
          role: 'system',
          content: `阶段「${phase.name}」等待你的反馈后继续执行。`,
        })
        this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_input')
        return
      }
      elog(`handlePhaseResult: autoAdvance overrides pending_input, proceeding`)
    }

    try {
      const task = this.taskRepo.findById(repoTaskId)
      if (task) {
        const sha = await getHead(task.worktree_path)
        this.commitRepo.save(repoTaskId, phase.id, sha)
      }
    }
    catch { /* non-git worktree */ }

    if (phase.id === 'create-branch') {
      this.syncBranchNameFromWorktree(repoTaskId)
    }

    if (phase.completion_check) {
      const task = this.taskRepo.findById(repoTaskId)
      if (task) {
        const passed = this.evaluateGate(
          phase.completion_check,
          task.worktree_path,
          task.openspec_path,
          wf,
        )
        elog(`handlePhaseResult: completion_check="${phase.completion_check}" passed=${passed} agentSignal=${agentSignal}`)
        if (!passed) {
          const gateDef = wf.gate_definitions?.[phase.completion_check]
          const desc = gateDef?.description ?? phase.completion_check
          this.msgRepo.create({
            repo_task_id: repoTaskId,
            phase_id: phase.id,
            role: 'system',
            content: agentSignal === 'complete'
              ? `Agent 声明已完成，但完成条件「${desc}」未通过验证，请检查产出后反馈。`
              : `阶段「${phase.name}」产出未就绪（${desc}），请反馈后继续。`,
          })
          this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_input')
          return
        }
      }
    }

    if (phase.requires_confirm && !shouldAutoAdvance) {
      this.msgRepo.create({
        repo_task_id: repoTaskId,
        phase_id: phase.id,
        role: 'system',
        content: `阶段「${phase.name}」已完成，等待确认后继续推进。`,
      })
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_confirm')
      return
    }

    if (phase.is_terminal) {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'completed')
      return
    }

    if (phase.loopable && phase.loop_target) {
      const loopTarget = findPhaseById(wf.stages, phase.loop_target)
      if (loopTarget) {
        this.taskRepo.updatePhase(repoTaskId, loopTarget.stage.id, loopTarget.phase.id, 'running')
        await this.executePhase(repoTaskId, loopTarget.phase, loopTarget.stage)
        return
      }
    }

    const next = this.getNextPhase(repoTaskId, stage.id, phase.id)
    if (!next) {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_event')
      return
    }

    this.taskRepo.updatePhase(repoTaskId, next.stage.id, next.phase.id, 'running')
    await this.executePhase(repoTaskId, next.phase, next.stage)
  }

  // ── 阶段导航 ──

  private getNextPhase(
    repoTaskId: string,
    currentStageId: string,
    currentPhaseId: string,
  ): { stage: StageConfig, phase: PhaseConfig } | undefined {
    const wf = this.resolveConfigForTask(repoTaskId)
    const loc = findPhaseInStages(wf.stages, currentStageId, currentPhaseId)
    if (!loc) return undefined

    const { stageIdx, phaseIdx } = loc
    const stages = wf.stages
    const currentStage = stages[stageIdx]

    for (let pi = phaseIdx + 1; pi < currentStage.phases.length; pi++) {
      const candidate = currentStage.phases[pi]
      if (candidate.optional && !this.isPhaseActivated(repoTaskId, candidate.id))
        continue
      return { stage: currentStage, phase: candidate }
    }

    if (stageIdx >= stages.length - 1)
      return undefined

    if (!this.checkStageGate(repoTaskId, currentStageId))
      return undefined

    const nextStage = stages[stageIdx + 1]
    for (const candidate of nextStage.phases) {
      if (candidate.optional && !this.isPhaseActivated(repoTaskId, candidate.id))
        continue
      return { stage: nextStage, phase: candidate }
    }

    return undefined
  }

  private checkStageGate(repoTaskId: string, stageId: string): boolean {
    const wf = this.resolveConfigForTask(repoTaskId)
    const stage = wf.stages.find(s => s.id === stageId)
    if (!stage?.gate)
      return true

    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return false

    return this.evaluateGate(stage.gate, task.worktree_path, task.openspec_path, wf)
  }

  private hasPhaseCompleted(repoTaskId: string, phaseId: string): boolean {
    if (this.commitRepo.get(repoTaskId, phaseId))
      return true

    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return false

    const wf = this.resolveConfigForTask(repoTaskId)
    const target = findPhaseById(wf.stages, phaseId)
    const current = findPhaseById(wf.stages, task.current_phase)

    if (!target) return false
    if (!current) return true

    return (current.stageIdx * 10000 + current.phaseIdx)
      > (target.stageIdx * 10000 + target.phaseIdx)
  }

  /**
   * 从 Agent 输出中解析状态标记。
   * Agent 应在回复末尾附加 <<PHASE_COMPLETE>> 或 <<PENDING_INPUT>>。
   */
  private parsePhaseSignal(output?: string): 'complete' | 'pending_input' | null {
    if (!output) return null
    const tail = output.slice(-500)
    if (tail.includes('<<PENDING_INPUT>>')) return 'pending_input'
    if (tail.includes('<<PHASE_COMPLETE>>')) return 'complete'
    return null
  }

  private stripPhaseSignals(text: string): string {
    return text.replace(/\s*<<(?:PHASE_COMPLETE|PENDING_INPUT)>>\s*/g, '').trimEnd()
  }

  /**
   * create-branch 阶段完成后，从 worktree 检测实际分支名并回写 task。
   * 这允许 agent 根据需求标题自行翻译生成语义化英文分支名。
   */
  private syncBranchNameFromWorktree(repoTaskId: string): void {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return

    try {
      const actual = execSync('git branch --show-current', {
        cwd: task.worktree_path,
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim()

      if (!actual || actual === task.branch_name) return

      const changeId = actual.startsWith('feature/')
        ? actual.slice('feature/'.length)
        : actual
      const openspecPath = `openspec/changes/${changeId}`

      elog(`syncBranchName: ${task.branch_name} → ${actual} (changeId=${changeId})`)
      this.taskRepo.updateChangeInfo(repoTaskId, actual, changeId, openspecPath)
    }
    catch (err) {
      elog(`syncBranchName failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private collectPhaseIdsAfter(stageIdx: number, phaseIdx: number, wf: WorkflowConfig): string[] {
    const result: string[] = []
    const stages = wf.stages
    for (let pi = phaseIdx; pi < stages[stageIdx].phases.length; pi++) {
      result.push(stages[stageIdx].phases[pi].id)
    }
    for (let si = stageIdx + 1; si < stages.length; si++) {
      for (const phase of stages[si].phases) {
        result.push(phase.id)
      }
    }
    return result
  }
}
