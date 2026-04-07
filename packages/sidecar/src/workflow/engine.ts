import { existsSync, readdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const LOG_FILE = join(tmpdir(), 'code-agent-engine.log')
function elog(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [engine] ${msg}\n`) } catch {}
}
import type Database from 'better-sqlite3'
import type { AgentProvider, PhaseResult } from '../providers/types'
import { buildPromptFromContext } from '../providers/cli.provider'
import { parseWorkflow, findPhaseById, findPhaseInStages, flattenPhases } from './parser'
import type { GateCheck, GateDefinition, PhaseConfig, StageConfig, WorkflowConfig } from './parser'
import { buildPhaseContext } from './context-builder'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { PhaseCommitRepository, INITIAL_PHASE_ID } from '../db/repositories/phase-commit.repo'
import { McpBindingRepository } from '../db/repositories/mcp-binding.repo'
import { RepoRepository } from '../db/repositories/repo.repo'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { getHead, getMergeBase, resetHard } from '../git/operations'
import { getConfigWriter } from '../mcp/config-writer'
import type { McpServerConfig } from '../mcp/config-writer'

export interface ResolveProviderOptions {
  resumeSessionId?: string
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
  private activeProviders = new Map<string, AgentProvider>()
  private liveOutputs = new Map<string, string>()
  private activatedPhases = new Map<string, Set<string>>()

  private rawYaml: string

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
    this.repoRepo = new RepoRepository(this.db)
    this.settingsRepo = new SettingsRepository(this.db)
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
  ): { stageId: string, phaseId: string } {
    const rules = this.config.state_inference?.rules
    const fallback = {
      stageId: this.config.stages[0].id,
      phaseId: this.config.stages[0].phases[0].id,
    }

    if (!rules?.length)
      return fallback

    for (const rule of rules) {
      if (this.evaluateGate(rule.condition, worktreePath, openspecPath))
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
  ): boolean {
    const def = this.config.gate_definitions?.[condition]
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

  getPhaseEnabledMap(): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    for (const stage of this.config.stages) {
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
  ): { targetStage: string, targetPhase?: string, strategy?: 'infer_from_state' } | null {
    for (const stage of this.config.stages) {
      for (const phase of stage.phases) {
        if (phase.triggers?.some(t => userInput.includes(t)))
          return { targetStage: stage.id, targetPhase: phase.id }
      }
    }

    for (const mapping of this.config.trigger_mapping ?? []) {
      if (mapping.patterns.some(p => userInput.includes(p))) {
        if (mapping.strategy === 'infer_from_state')
          return { targetStage: mapping.target_stage, strategy: 'infer_from_state' }
        return { targetStage: mapping.target_stage, targetPhase: mapping.target_phase }
      }
    }

    return null
  }

  // ── 工作流生命周期 ──

  async startWorkflow(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    if (!this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)) {
      try {
        const sha = await getMergeBase(task.worktree_path) ?? await getHead(task.worktree_path)
        this.commitRepo.save(repoTaskId, INITIAL_PHASE_ID, sha)
      }
      catch { /* non-git worktree, skip */ }
    }

    const { stageId, phaseId } = this.inferStageAndPhase(task.worktree_path, task.openspec_path)
    const found = findPhaseInStages(this.config.stages, stageId, phaseId)
    const stage = found?.stage ?? this.config.stages[0]
    const phase = found?.phase ?? this.config.stages[0].phases[0]

    this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'running')
    await this.executePhase(repoTaskId, phase, stage)
  }

  async confirmPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`confirmPhase: task=${repoTaskId} stage=${task?.current_stage} phase=${task?.current_phase} status=${task?.phase_status}`)
    if (!task || task.phase_status !== 'waiting_confirm')
      throw new Error(`Task ${repoTaskId} is not in waiting_confirm state`)

    const found = findPhaseById(this.config.stages, task.current_phase)
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

    if (phase.loopable && phase.loop_target) {
      const loopTarget = findPhaseById(this.config.stages, phase.loop_target)
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

  async provideFeedback(repoTaskId: string, feedback: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`provideFeedback: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status} feedback=${feedback.slice(0, 100)}`)
    const allowedStates = ['waiting_confirm', 'failed', 'cancelled']
    if (!task || !allowedStates.includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a feedbackable state (current: ${task?.phase_status})`)

    const found = findPhaseById(this.config.stages, task.current_phase)
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

  async routeAndExecute(repoTaskId: string, userInput: string): Promise<string | null> {
    const match = this.routeTrigger(userInput)
    if (!match)
      return null

    if (match.strategy === 'infer_from_state') {
      await this.startWorkflow(repoTaskId)
      return 'infer_from_state'
    }

    if (match.targetPhase) {
      const found = findPhaseInStages(this.config.stages, match.targetStage, match.targetPhase)
      if (found) {
        if (found.phase.optional)
          this.activatePhase(repoTaskId, found.phase.id)
        this.taskRepo.updatePhase(repoTaskId, found.stage.id, found.phase.id, 'running')
        await this.executePhase(repoTaskId, found.phase, found.stage, userInput)
        return found.phase.id
      }
    }

    const stage = this.config.stages.find(s => s.id === match.targetStage)
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

    const found = findPhaseById(this.config.stages, task.current_phase)
    if (!found)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)

    this.taskRepo.updatePhase(repoTaskId, found.stage.id, found.phase.id, 'running')
    await this.executePhase(repoTaskId, found.phase, found.stage, undefined, { skipEntryGate: true })
  }

  async resetTask(repoTaskId: string): Promise<void> {
    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)
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
    const firstStage = this.config.stages[0]
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
  ): Promise<void> {
    elog(`rollbackToPhase: task=${repoTaskId} targetStage=${targetStageId} targetPhase=${targetPhaseId}`)
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    const target = findPhaseInStages(this.config.stages, targetStageId, targetPhaseId)
    if (!target)
      throw new Error(`Phase "${targetPhaseId}" not found in stage "${targetStageId}"`)

    const current = findPhaseById(this.config.stages, task.current_phase)
    if (current) {
      const targetFlat = target.stageIdx * 10000 + target.phaseIdx
      const currentFlat = current.stageIdx * 10000 + current.phaseIdx
      if (targetFlat > currentFlat)
        throw new Error(`Cannot roll forward: target "${targetStageId}/${targetPhaseId}" is after current "${task.current_stage}/${task.current_phase}"`)
    }

    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)

    let resetSha: string | null = null
    if (target.stageIdx === 0 && target.phaseIdx === 0) {
      resetSha = this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
    }
    else {
      const allPhases = flattenPhases(this.config)
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

    const phasesToClear = this.collectPhaseIdsAfter(target.stageIdx, target.phaseIdx)
    this.msgRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)
    this.runRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)
    this.commitRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)

    this.taskRepo.updatePhase(repoTaskId, targetStageId, targetPhaseId, 'running')
    await this.executePhase(repoTaskId, target.phase, target.stage, undefined, { skipEntryGate: true })
  }

  async rollbackToStage(repoTaskId: string, targetStageId: string): Promise<void> {
    const stage = this.config.stages.find(s => s.id === targetStageId)
    if (!stage)
      throw new Error(`Stage "${targetStageId}" not found`)
    await this.rollbackToPhase(repoTaskId, targetStageId, stage.phases[0].id)
  }

  getFullConfig(): WorkflowConfig {
    return this.config
  }

  getRawYaml(): string {
    return this.rawYaml
  }

  reloadConfig(yamlContent: string): void {
    this.config = parseWorkflow(yamlContent)
    this.rawYaml = yamlContent
  }

  resolveSkill(skillPath: string): string {
    return this.resolveSkillContent(skillPath)
  }

  getStagesAndPhases(): { id: string, name: string, phases: { id: string, name: string }[] }[] {
    return this.config.stages.map(s => ({
      id: s.id,
      name: s.name,
      phases: s.phases.map(p => ({ id: p.id, name: p.name })),
    }))
  }

  getRequirementPhases(): { id: string, name: string, optional?: boolean, skippable?: boolean }[] {
    return (this.config.requirement_phases ?? []).map(p => ({
      id: p.id,
      name: p.name,
      optional: p.optional,
      skippable: p.skippable,
    }))
  }

  async executeRequirementPhase(
    repoTaskId: string,
    phaseId: string,
    userMessage?: string,
  ): Promise<void> {
    const phase = (this.config.requirement_phases ?? []).find(p => p.id === phaseId)
    if (!phase)
      throw new Error(`Requirement phase "${phaseId}" not found`)

    const virtualStage: StageConfig = { id: '_requirements', name: '需求收集', phases: this.config.requirement_phases ?? [] }
    this.taskRepo.updatePhase(repoTaskId, '_requirements', phaseId, 'running')
    await this.executePhase(repoTaskId, phase, virtualStage, userMessage)
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
  previewPhasePromptTemplate(phaseId: string): string {
    const found = findPhaseById(this.config.stages, phaseId)
      ?? (this.config.requirement_phases ?? []).map((p) => {
        if (p.id !== phaseId) return null
        const virtualStage = { id: '_requirements', name: '需求收集', phases: this.config.requirement_phases ?? [] }
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
      guardrailDefinitions: this.config.guardrail_definitions,
      gateDefinitions: this.config.gate_definitions,
    }

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
      { title: '<需求标题>', description: '<需求描述>' },
      (stage as StageConfig).gate,
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

    const found = findPhaseById(this.config.stages, phaseId)
      ?? (this.config.requirement_phases ?? []).map((p, i) => {
        if (p.id !== phaseId) return null
        const virtualStage = { id: '_requirements', name: '需求收集', phases: this.config.requirement_phases ?? [] }
        return { stage: virtualStage, phase: p, stageIdx: -1, phaseIdx: i }
      }).find(Boolean)

    if (!found) throw new Error(`Phase ${phaseId} not found in workflow config`)
    const { stage, phase } = found

    const requirement = this.reqRepo.findById(task.requirement_id)

    const history = this.msgRepo
      .findByTaskAndPhase(repoTaskId, phase.id)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const reqInfo = requirement
      ? { title: requirement.title, description: requirement.description }
      : undefined

    const ctxDeps = {
      resolveSkillContent: this.resolveSkillContent,
      guardrailDefinitions: this.config.guardrail_definitions,
      gateDefinitions: this.config.gate_definitions,
    }

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
      (stage as StageConfig).gate,
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

      if (phase.entry_gate && !options?.skipEntryGate) {
        const gatePassed = this.evaluateGate(
          phase.entry_gate,
          task.worktree_path,
          task.openspec_path,
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
        ? { title: requirement.title, description: requirement.description }
        : undefined

      const ctxDeps = {
        resolveSkillContent: this.resolveSkillContent,
        guardrailDefinitions: this.config.guardrail_definitions,
        gateDefinitions: this.config.gate_definitions,
      }

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
            stage.gate,
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
            stage.gate,
          )

      const agentRun = this.runRepo.create({
        repo_task_id: repoTaskId,
        phase_id: phase.id,
        provider: phase.provider,
      })
      agentRunId = agentRun.id

      const provider = this.resolveProvider(phase.provider, {
        resumeSessionId: previousSessionId ?? undefined,
      })
      this.activeProviders.set(repoTaskId, provider)
      this.liveOutputs.set(repoTaskId, '')

      const canReadFiles = this.cliType === 'cursor-cli' || this.cliType === 'claude-code'
      const promptText = isResume && context.userMessage
        ? context.userMessage
        : buildPromptFromContext(context, canReadFiles)
      this.msgRepo.create({
        repo_task_id: repoTaskId,
        phase_id: phase.id,
        role: 'prompt',
        content: promptText,
      })

      const mcpServers = this.mcpBindingRepo.resolveServersForPhase(stage.id, phase.id)
      const configWriter = getConfigWriter(this.cliType)
      const cwd = task.worktree_path

      if (mcpServers.length > 0) {
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
        elog(`executePhase: injected ${mcpServers.length} MCP server(s) for ${stage.id}/${phase.id}`)
      }

      let result: PhaseResult
      try {
        result = await provider.run(context, {
          onChunk: (chunk) => {
            const current = this.liveOutputs.get(repoTaskId) ?? ''
            this.liveOutputs.set(repoTaskId, current + chunk)
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
          content: result.output,
        })
      }

      setTimeout(() => this.liveOutputs.delete(repoTaskId), 2000)

      await this.handlePhaseResult(repoTaskId, phase, stage, result)
    }
    catch (err: unknown) {
      this.activeProviders.delete(repoTaskId)
      this.liveOutputs.delete(repoTaskId)
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
    elog(`handlePhaseResult: stage=${stage.id} phase=${phase.id} status=${result.status} requires_confirm=${phase.requires_confirm} completion_check=${phase.completion_check ?? 'none'} error=${result.error?.slice(0, 200) ?? 'none'}`)
    if (result.status === 'failed' || result.status === 'cancelled') {
      this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, result.status)
      return
    }

    try {
      const task = this.taskRepo.findById(repoTaskId)
      if (task) {
        const sha = await getHead(task.worktree_path)
        this.commitRepo.save(repoTaskId, phase.id, sha)
      }
    }
    catch { /* non-git worktree */ }

    if (phase.completion_check) {
      const task = this.taskRepo.findById(repoTaskId)
      if (task) {
        const passed = this.evaluateGate(
          phase.completion_check,
          task.worktree_path,
          task.openspec_path,
        )
        elog(`handlePhaseResult: completion_check="${phase.completion_check}" passed=${passed}`)
        if (!passed) {
          const reason = `阶段「${phase.name}」的完成条件「${phase.completion_check}」未满足，请检查产出后重试或提供反馈。`
          this.msgRepo.create({
            repo_task_id: repoTaskId,
            phase_id: phase.id,
            role: 'assistant',
            content: reason,
          })
          this.taskRepo.updatePhase(repoTaskId, stage.id, phase.id, 'waiting_confirm')
          return
        }
      }
    }

    if (phase.requires_confirm) {
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
      const loopTarget = findPhaseById(this.config.stages, phase.loop_target)
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
    const loc = findPhaseInStages(this.config.stages, currentStageId, currentPhaseId)
    if (!loc) return undefined

    const { stageIdx, phaseIdx } = loc
    const stages = this.config.stages
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
    const stage = this.config.stages.find(s => s.id === stageId)
    if (!stage?.gate)
      return true

    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return false

    return this.evaluateGate(stage.gate, task.worktree_path, task.openspec_path)
  }

  private hasPhaseCompleted(repoTaskId: string, phaseId: string): boolean {
    if (this.commitRepo.get(repoTaskId, phaseId))
      return true

    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return false

    const target = findPhaseById(this.config.stages, phaseId)
    const current = findPhaseById(this.config.stages, task.current_phase)

    if (!target) return false
    if (!current) return true

    return (current.stageIdx * 10000 + current.phaseIdx)
      > (target.stageIdx * 10000 + target.phaseIdx)
  }

  private collectPhaseIdsAfter(stageIdx: number, phaseIdx: number): string[] {
    const result: string[] = []
    const stages = this.config.stages
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
