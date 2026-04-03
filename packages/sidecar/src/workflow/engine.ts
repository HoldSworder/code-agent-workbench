import type Database from 'better-sqlite3'
import type { AgentProvider, PhaseContext, PhaseResult } from '../providers/types'
import { parseWorkflow } from './parser'
import type { PhaseConfig, WorkflowConfig } from './parser'
import { buildPhaseContext } from './context-builder'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { MessageRepository } from '../db/repositories/message.repo'

export interface WorkflowEngineOptions {
  db: Database.Database
  workflowYaml: string
  resolveProvider: (provider: string) => AgentProvider
  resolveSkillContent: (skillPath: string) => string
}

export class WorkflowEngine {
  private db: Database.Database
  private config: WorkflowConfig
  private resolveProvider: (provider: string) => AgentProvider
  private resolveSkillContent: (skillPath: string) => string
  private taskRepo: RepoTaskRepository
  private runRepo: AgentRunRepository
  private msgRepo: MessageRepository
  private activeProviders = new Map<string, AgentProvider>()

  constructor(opts: WorkflowEngineOptions) {
    this.db = opts.db
    this.config = parseWorkflow(opts.workflowYaml)
    this.resolveProvider = opts.resolveProvider
    this.resolveSkillContent = opts.resolveSkillContent
    this.taskRepo = new RepoTaskRepository(this.db)
    this.runRepo = new AgentRunRepository(this.db)
    this.msgRepo = new MessageRepository(this.db)
  }

  async startWorkflow(repoTaskId: string): Promise<void> {
    const firstPhase = this.config.phases[0]
    this.taskRepo.updatePhase(repoTaskId, firstPhase.id, 'running')
    await this.executePhase(repoTaskId, firstPhase)
  }

  async confirmPhase(repoTaskId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task || task.phase_status !== 'waiting_confirm')
      throw new Error(`Task ${repoTaskId} is not in waiting_confirm state`)

    const nextPhase = this.getNextPhase(task.current_phase)
    if (!nextPhase) {
      this.taskRepo.updatePhase(repoTaskId, task.current_phase, 'waiting_event')
      return
    }

    this.taskRepo.updatePhase(repoTaskId, nextPhase.id, 'running')
    await this.executePhase(repoTaskId, nextPhase)
  }

  async provideFeedback(repoTaskId: string, feedback: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task || task.phase_status !== 'waiting_confirm')
      throw new Error(`Task ${repoTaskId} is not in waiting_confirm state`)

    const phase = this.config.phases.find(p => p.id === task.current_phase)
    if (!phase)
      throw new Error(`Phase ${task.current_phase} not found in workflow config`)

    this.taskRepo.updatePhase(repoTaskId, phase.id, 'running')
    await this.executePhase(repoTaskId, phase, feedback)
  }

  async triggerEvent(repoTaskId: string, eventId: string): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)
    if (!task || task.phase_status !== 'waiting_event')
      throw new Error(`Task ${repoTaskId} is not in waiting_event state`)

    const event = this.config.events?.find(e => e.id === eventId)
    if (!event)
      throw new Error(`Event ${eventId} not found in workflow config`)

    const syntheticPhase: PhaseConfig = {
      id: event.id,
      name: event.name,
      requires_confirm: false,
      provider: event.provider,
      skill: event.skill,
      tools: event.tools,
      mcp_config: event.mcp_config,
      script: event.script,
    }

    this.taskRepo.updatePhase(repoTaskId, event.id, 'running')
    await this.executePhase(repoTaskId, syntheticPhase)
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

  private async executePhase(
    repoTaskId: string,
    phase: PhaseConfig,
    userMessage?: string,
  ): Promise<void> {
    const task = this.taskRepo.findById(repoTaskId)!

    const context = buildPhaseContext(
      phase,
      task.worktree_path,
      task.openspec_path,
      task.branch_name,
      { resolveSkillContent: this.resolveSkillContent },
      userMessage,
    )

    const agentRun = this.runRepo.create({
      repo_task_id: repoTaskId,
      phase_id: phase.id,
      provider: phase.provider,
    })

    const provider = this.resolveProvider(phase.provider)
    this.activeProviders.set(repoTaskId, provider)

    const result = await provider.run(context)
    this.activeProviders.delete(repoTaskId)

    this.runRepo.finish(
      agentRun.id,
      result.status,
      result.tokenUsage,
      result.error,
    )

    if (result.output) {
      this.msgRepo.create({
        repo_task_id: repoTaskId,
        phase_id: phase.id,
        role: 'assistant',
        content: result.output,
      })
    }

    await this.handlePhaseResult(repoTaskId, phase, result)
  }

  private async handlePhaseResult(
    repoTaskId: string,
    phase: PhaseConfig,
    result: PhaseResult,
  ): Promise<void> {
    if (result.status === 'failed' || result.status === 'cancelled') {
      this.taskRepo.updatePhase(repoTaskId, phase.id, result.status)
      return
    }

    if (phase.requires_confirm) {
      this.taskRepo.updatePhase(repoTaskId, phase.id, 'waiting_confirm')
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
}
