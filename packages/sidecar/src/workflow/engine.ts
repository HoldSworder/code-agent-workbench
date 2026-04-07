import { existsSync, readdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const LOG_FILE = join(tmpdir(), 'code-agent-engine.log')
function elog(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} [engine] ${msg}\n`) } catch {}
}
import type Database from 'better-sqlite3'
import type { AgentProvider, PhaseContext, PhaseResult } from '../providers/types'
import { parseWorkflow } from './parser'
import type { EventConfig, PhaseConfig, WorkflowConfig } from './parser'
import { buildPhaseContext } from './context-builder'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { PhaseCommitRepository, INITIAL_PHASE_ID } from '../db/repositories/phase-commit.repo'
import { getHead, getMergeBase, resetHard } from '../git/operations'

export interface ResolveProviderOptions {
  resumeSessionId?: string
}

export interface WorkflowEngineOptions {
  db: Database.Database
  workflowYaml: string
  resolveProvider: (provider: string, options?: ResolveProviderOptions) => AgentProvider
  resolveSkillContent: (skillPath: string) => string
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
  private activeProviders = new Map<string, AgentProvider>()
  private liveOutputs = new Map<string, string>()

  constructor(opts: WorkflowEngineOptions) {
    this.db = opts.db
    this.config = parseWorkflow(opts.workflowYaml)
    this.resolveProvider = opts.resolveProvider
    this.resolveSkillContent = opts.resolveSkillContent
    this.taskRepo = new RepoTaskRepository(this.db)
    this.runRepo = new AgentRunRepository(this.db)
    this.msgRepo = new MessageRepository(this.db)
    this.reqRepo = new RequirementRepository(this.db)
    this.commitRepo = new PhaseCommitRepository(this.db)
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
      if (dep.type === 'cli') {
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

  inferPhase(worktreePath: string, openspecPath: string): string {
    const rules = this.config.state_inference?.rules
    if (!rules?.length)
      return this.config.phases[0].id

    const absOpenspec = join(worktreePath, openspecPath)
    const changeExists = existsSync(absOpenspec)

    for (const rule of rules) {
      const matched = this.evaluateCondition(rule.condition, absOpenspec, changeExists)
      if (matched)
        return rule.phase
    }

    return this.config.phases[0].id
  }

  private evaluateCondition(
    condition: string,
    openspecDir: string,
    changeExists: boolean,
  ): boolean {
    switch (condition) {
      case 'no_change_dir':
        return !changeExists

      case 'has_proposal_and_specs_no_tasks':
        return changeExists
          && existsSync(join(openspecDir, 'proposal.md'))
          && existsSync(join(openspecDir, 'specs'))
          && !existsSync(join(openspecDir, 'tasks.md'))

      case 'tasks_has_unchecked':
        return changeExists && this.tasksHaveUnchecked(openspecDir)

      case 'tasks_all_checked':
        return changeExists && this.tasksAllChecked(openspecDir)

      case 'e2e_report_pass':
        return changeExists && this.e2eReportAllowsArchive(openspecDir)

      case 'e2e_report_fail_no_consent':
        return changeExists
          && existsSync(join(openspecDir, 'e2e-report.md'))
          && !this.e2eReportAllowsArchive(openspecDir)

      default:
        return false
    }
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

  /**
   * 简单通配符匹配：仅支持路径中的单个 `*` 段（如 `dir/* /file.md`）。
   * 返回是否有至少一个匹配。
   */
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

  private tasksHaveUnchecked(openspecDir: string): boolean {
    const tasksPath = join(openspecDir, 'tasks.md')
    if (!existsSync(tasksPath))
      return false
    const content = readFileSync(tasksPath, 'utf-8')
    return content.includes('- [ ]')
  }

  private tasksAllChecked(openspecDir: string): boolean {
    const tasksPath = join(openspecDir, 'tasks.md')
    if (!existsSync(tasksPath))
      return false
    const content = readFileSync(tasksPath, 'utf-8')
    return content.includes('- [x]') && !content.includes('- [ ]')
  }

  private e2eReportAllowsArchive(openspecDir: string): boolean {
    const reportPath = join(openspecDir, 'e2e-report.md')
    if (!existsSync(reportPath))
      return false
    const content = readFileSync(reportPath, 'utf-8')
    const conclusionSection = content.split('## 验收结论')[1] ?? ''
    return conclusionSection.includes('通过')
      || conclusionSection.includes('用户同意')
  }

  // ── 触发语路由 ──

  routeTrigger(userInput: string): string | null {
    // 先检查事件级 triggers
    for (const event of this.config.events ?? []) {
      if (event.triggers?.some(t => userInput.includes(t)))
        return event.id
    }

    // 再检查全局 trigger_mapping
    for (const mapping of this.config.trigger_mapping ?? []) {
      if (mapping.patterns.some(p => userInput.includes(p)))
        return mapping.target
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

    const inferredPhaseId = this.inferPhase(task.worktree_path, task.openspec_path)
    const phase = this.config.phases.find(p => p.id === inferredPhaseId)
      ?? this.config.phases[0]

    this.taskRepo.updatePhase(repoTaskId, phase.id, 'running')
    await this.executePhase(repoTaskId, phase)
  }

  async confirmPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`confirmPhase: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status}`)
    if (!task || task.phase_status !== 'waiting_confirm')
      throw new Error(`Task ${repoTaskId} is not in waiting_confirm state`)

    const phase = this.config.phases.find(p => p.id === task.current_phase)
      ?? (this.config.events?.find(e => e.id === task.current_phase)
        ? this.eventToPhaseConfig(this.config.events.find(e => e.id === task.current_phase)!)
        : null)

    // confirm_files 存在性校验（跳过 __agent_output__ 等特殊标记）
    if (phase?.confirm_files?.length) {
      const missing = this.validateConfirmFiles(phase.confirm_files, task.worktree_path, task.openspec_path, task.change_id)
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

    // 终态事件确认 → completed
    if (phase?.is_terminal) {
      this.taskRepo.updatePhase(repoTaskId, task.current_phase, 'completed')
      return
    }

    const nextPhase = this.getNextPhase(task.current_phase)
    elog(`confirmPhase: nextPhase=${nextPhase?.id ?? 'none'}`)
    if (!nextPhase) {
      this.taskRepo.updatePhase(repoTaskId, task.current_phase, 'waiting_event')
      return
    }

    this.taskRepo.updatePhase(repoTaskId, nextPhase.id, 'running')
    await this.executePhase(repoTaskId, nextPhase)
  }

  async provideFeedback(repoTaskId: string, feedback: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    elog(`provideFeedback: task=${repoTaskId} phase=${task?.current_phase} status=${task?.phase_status} feedback=${feedback.slice(0, 100)}`)
    const allowedStates = ['waiting_confirm', 'failed', 'cancelled']
    if (!task || !allowedStates.includes(task.phase_status))
      throw new Error(`Task ${repoTaskId} is not in a feedbackable state (current: ${task?.phase_status})`)

    const phase = this.config.phases.find(p => p.id === task.current_phase)
      ?? (this.config.events?.find(e => e.id === task.current_phase)
        ? this.eventToPhaseConfig(this.config.events.find(e => e.id === task.current_phase)!)
        : null)
    if (!phase)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)

    this.msgRepo.create({
      repo_task_id: repoTaskId,
      phase_id: phase.id,
      role: 'user',
      content: feedback,
    })

    this.taskRepo.updatePhase(repoTaskId, phase.id, 'running')
    await this.executePhase(repoTaskId, phase, feedback)
  }

  async triggerEvent(repoTaskId: string, eventId: string, payload?: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task || task.phase_status !== 'waiting_event')
      throw new Error(`Task ${repoTaskId} is not in waiting_event state`)

    const event = this.config.events?.find(e => e.id === eventId)
    if (!event)
      throw new Error(`Event ${eventId} not found in workflow config`)

    // after_phase 门禁：事件只能在指定阶段走完之后触发
    if (event.after_phase) {
      const passed = this.hasPhaseCompleted(repoTaskId, event.after_phase)
      if (!passed) {
        throw new Error(
          `Event "${eventId}" requires phase "${event.after_phase}" to be completed first, `
          + `but current phase is "${task.current_phase}"`,
        )
      }
    }

    if (event.precondition) {
      const absOpenspec = join(task.worktree_path, task.openspec_path)
      const met = this.evaluateCondition(event.precondition, absOpenspec, existsSync(absOpenspec))
      if (!met)
        throw new Error(`Precondition "${event.precondition}" not met for event ${eventId}`)
    }

    const syntheticPhase = this.eventToPhaseConfig(event)
    this.taskRepo.updatePhase(repoTaskId, event.id, 'running')
    await this.executePhase(repoTaskId, syntheticPhase, payload)
  }

  /**
   * 自动路由：根据用户输入判断应触发的阶段/事件，并执行。
   */
  async routeAndExecute(repoTaskId: string, userInput: string): Promise<string | null> {
    const target = this.routeTrigger(userInput)
    if (!target)
      return null

    if (target === 'infer_from_state') {
      await this.startWorkflow(repoTaskId)
      return 'infer_from_state'
    }

    const event = this.config.events?.find(e => e.id === target)
    if (event) {
      await this.triggerEvent(repoTaskId, event.id, userInput)
      return event.id
    }

    const phase = this.config.phases.find(p => p.id === target)
    if (phase) {
      this.taskRepo.updatePhase(repoTaskId, phase.id, 'running')
      await this.executePhase(repoTaskId, phase, userInput)
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

    const phase = this.config.phases.find(p => p.id === task.current_phase)
    const event = this.config.events?.find(e => e.id === task.current_phase)

    const phaseConfig = phase ?? (event ? this.eventToPhaseConfig(event) : null)
    if (!phaseConfig)
      throw new Error(`Phase/event ${task.current_phase} not found in workflow config`)

    this.taskRepo.updatePhase(repoTaskId, task.current_phase, 'running')
    await this.executePhase(repoTaskId, phaseConfig)
  }

  async resetTask(repoTaskId: string): Promise<void> {
    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)

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
    const firstPhase = this.config.phases[0]
    this.taskRepo.updatePhase(repoTaskId, firstPhase.id, 'pending')
  }

  async resetCurrentPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)
    elog(`resetCurrentPhase: task=${repoTaskId} current_phase=${task.current_phase} status=${task.phase_status}`)

    await this.rollbackToPhase(repoTaskId, task.current_phase)
  }

  async rollbackToPhase(repoTaskId: string, targetPhaseId: string): Promise<void> {
    elog(`rollbackToPhase: task=${repoTaskId} target=${targetPhaseId}`)
    const task = this.taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    const targetIdx = this.config.phases.findIndex(p => p.id === targetPhaseId)
    elog(`rollbackToPhase: targetIdx=${targetIdx} currentPhase=${task.current_phase} currentStatus=${task.phase_status}`)
    if (targetIdx === -1)
      throw new Error(`Phase "${targetPhaseId}" not found in workflow config`)

    const currentIdx = this.config.phases.findIndex(p => p.id === task.current_phase)
    if (currentIdx !== -1 && targetIdx > currentIdx)
      throw new Error(`Cannot roll forward: target "${targetPhaseId}" is after current "${task.current_phase}"`)

    await this.cancelCurrentAgent(repoTaskId)
    this.liveOutputs.delete(repoTaskId)

    let resetSha: string | null = null
    if (targetIdx === 0) {
      resetSha = this.commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
    }
    else {
      const prevPhaseId = this.config.phases[targetIdx - 1].id
      resetSha = this.commitRepo.get(repoTaskId, prevPhaseId)
    }

    if (!resetSha) {
      resetSha = await getMergeBase(task.worktree_path)
      if (resetSha) this.commitRepo.save(repoTaskId, INITIAL_PHASE_ID, resetSha)
    }

    if (resetSha) {
      try { await resetHard(task.worktree_path, resetSha) }
      catch (e) { process.stderr.write(`[workflow] git reset failed on rollback: ${e}\n`) }
    }

    const phasesToClear = this.config.phases
      .slice(targetIdx)
      .map(p => p.id)
    this.msgRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)
    this.runRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)
    this.commitRepo.deleteByTaskAndPhases(repoTaskId, phasesToClear)

    const phase = this.config.phases[targetIdx]
    this.taskRepo.updatePhase(repoTaskId, targetPhaseId, 'running')
    await this.executePhase(repoTaskId, phase)
  }

  getPhases(): { id: string, name: string }[] {
    return this.config.phases.map(p => ({ id: p.id, name: p.name }))
  }

  async cancelCurrentAgent(repoTaskId: string): Promise<void> {
    const provider = this.activeProviders.get(repoTaskId)
    if (provider) {
      await provider.cancel()
      this.activeProviders.delete(repoTaskId)
    }

    const task = this.taskRepo.findById(repoTaskId)
    if (task)
      this.taskRepo.updatePhase(repoTaskId, task.current_phase, 'cancelled')
  }

  // ── 内部执行 ──

  private async executePhase(
    repoTaskId: string,
    phase: PhaseConfig,
    userMessage?: string,
  ): Promise<void> {
    elog(`executePhase: task=${repoTaskId} phase=${phase.id} provider=${phase.provider} hasUserMsg=${!!userMessage}`)
    let agentRunId: string | null = null

    try {
      const task = this.taskRepo.findById(repoTaskId)!

      // entry_gate: 进入本阶段前的前置条件校验
      if (phase.entry_gate) {
        const absOpenspec = join(task.worktree_path, task.openspec_path)
        const gatePassed = this.evaluateCondition(
          phase.entry_gate,
          absOpenspec,
          existsSync(absOpenspec),
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
          this.taskRepo.updatePhase(repoTaskId, phase.id, 'failed')
          return
        }
      }

      const requirement = this.reqRepo.findById(task.requirement_id)

      // Check if we can resume a previous session for faster startup
      const previousSessionId = this.runRepo.findLastSessionId(repoTaskId, phase.id)
      const isResume = !!previousSessionId && !!userMessage

      const history = this.msgRepo
        .findByTaskAndPhase(repoTaskId, phase.id)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const reqInfo = requirement
        ? { title: requirement.title, description: requirement.description }
        : undefined

      const context = isResume
        ? buildPhaseContext(
            phase,
            task.worktree_path,
            task.openspec_path,
            task.branch_name,
            task.change_id,
            { resolveSkillContent: this.resolveSkillContent },
            userMessage,
            undefined,
            true,
            reqInfo,
          )
        : buildPhaseContext(
            phase,
            task.worktree_path,
            task.openspec_path,
            task.branch_name,
            task.change_id,
            { resolveSkillContent: this.resolveSkillContent },
            userMessage,
            history.length > 0 ? history : undefined,
            false,
            reqInfo,
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

      const result = await provider.run(context, {
        onChunk: (chunk) => {
          const current = this.liveOutputs.get(repoTaskId) ?? ''
          this.liveOutputs.set(repoTaskId, current + chunk)
        },
      })
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

      await this.handlePhaseResult(repoTaskId, phase, result)
    }
    catch (err: unknown) {
      this.activeProviders.delete(repoTaskId)
      this.liveOutputs.delete(repoTaskId)
      const errMsg = err instanceof Error ? err.message : String(err)

      if (agentRunId)
        this.runRepo.finish(agentRunId, 'failed', undefined, errMsg)

      this.taskRepo.updatePhase(repoTaskId, phase.id, 'failed')
      process.stderr.write(`[workflow] executePhase crashed for ${repoTaskId}/${phase.id}: ${errMsg}\n`)
    }
  }

  private async handlePhaseResult(
    repoTaskId: string,
    phase: PhaseConfig,
    result: PhaseResult,
  ): Promise<void> {
    elog(`handlePhaseResult: phase=${phase.id} status=${result.status} requires_confirm=${phase.requires_confirm} completion_check=${phase.completion_check ?? 'none'} error=${result.error?.slice(0, 200) ?? 'none'}`)
    if (result.status === 'failed' || result.status === 'cancelled') {
      this.taskRepo.updatePhase(repoTaskId, phase.id, result.status)
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

    // completion_check: 校验阶段产出是否达标
    if (phase.completion_check) {
      const task = this.taskRepo.findById(repoTaskId)
      if (task) {
        const absOpenspec = join(task.worktree_path, task.openspec_path)
        const passed = this.evaluateCondition(
          phase.completion_check,
          absOpenspec,
          existsSync(absOpenspec),
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
          this.taskRepo.updatePhase(repoTaskId, phase.id, 'waiting_confirm')
          return
        }
      }
    }

    if (phase.requires_confirm) {
      this.taskRepo.updatePhase(repoTaskId, phase.id, 'waiting_confirm')
      return
    }

    // 终态事件完成 → completed
    if (phase.is_terminal) {
      this.taskRepo.updatePhase(repoTaskId, phase.id, 'completed')
      return
    }

    const nextPhase = this.getNextPhase(phase.id)
    if (!nextPhase) {
      this.taskRepo.updatePhase(repoTaskId, phase.id, 'waiting_event')
      return
    }

    this.taskRepo.updatePhase(repoTaskId, nextPhase.id, 'running')
    await this.executePhase(repoTaskId, nextPhase)
  }

  private getNextPhase(currentPhaseId: string): PhaseConfig | undefined {
    const idx = this.config.phases.findIndex(p => p.id === currentPhaseId)
    if (idx === -1 || idx >= this.config.phases.length - 1)
      return undefined
    return this.config.phases[idx + 1]
  }

  /**
   * 判断指定阶段是否已经完成。
   * 依据：存在该阶段的 commit 记录，或当前阶段索引已超过目标阶段。
   */
  private hasPhaseCompleted(repoTaskId: string, phaseId: string): boolean {
    if (this.commitRepo.get(repoTaskId, phaseId))
      return true

    const task = this.taskRepo.findById(repoTaskId)
    if (!task) return false

    const targetIdx = this.config.phases.findIndex(p => p.id === phaseId)
    const currentIdx = this.config.phases.findIndex(p => p.id === task.current_phase)

    if (targetIdx === -1) return false
    if (currentIdx === -1) return true

    return currentIdx > targetIdx
  }

  private eventToPhaseConfig(event: EventConfig): PhaseConfig {
    return {
      id: event.id,
      name: event.name,
      requires_confirm: !!event.confirm_files?.length,
      provider: event.provider,
      skill: event.skill,
      invoke_skills: event.invoke_skills,
      invoke_commands: event.invoke_commands,
      tools: event.tools,
      mcp_config: event.mcp_config,
      confirm_files: event.confirm_files,
      script: event.script,
      is_terminal: event.is_terminal,
    }
  }
}
