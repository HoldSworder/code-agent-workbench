import type Database from 'better-sqlite3'
import type { AgentProvider, RunOptions } from '../providers/types'
import type { CliProviderConfig } from '../providers/cli.provider'
import { ExternalCliProvider } from '../providers/cli.provider'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { OrchestratorRepository } from './repository'
import { LeaderLoop } from './leader'
import type { TeamConfig, RoleConfig } from './types'
import { AgentOutputBuffer } from './output-buffer'

export interface OrchestratorOptions {
  db: Database.Database
  teamConfig: TeamConfig
  teamYamlPath: string
  repoPath: string
  defaultBranch?: string
  sniProxyPatch?: CliProviderConfig['sniProxyPatch']
  onChunk?: RunOptions['onChunk']
  onEvent?: (event: string, data?: unknown) => void
}

export class Orchestrator {
  private repo: OrchestratorRepository
  private settings: SettingsRepository
  private leaderLoop: LeaderLoop | null = null
  private teamConfig: TeamConfig
  private _teamYamlPath: string
  private repoPath: string
  private defaultBranch: string
  private onChunk?: RunOptions['onChunk']
  private onEvent?: (event: string, data?: unknown) => void
  readonly outputBuffer = new AgentOutputBuffer()

  constructor(private options: OrchestratorOptions) {
    this.repo = new OrchestratorRepository(options.db)
    this.settings = new SettingsRepository(options.db)
    this.teamConfig = options.teamConfig
    this._teamYamlPath = options.teamYamlPath
    this.repoPath = options.repoPath
    this.defaultBranch = options.defaultBranch ?? 'main'
    this.onChunk = options.onChunk
    this.onEvent = options.onEvent
  }

  get repository(): OrchestratorRepository {
    return this.repo
  }

  get isRunning(): boolean {
    return this.leaderLoop?.isRunning ?? false
  }

  get config(): TeamConfig {
    return this.teamConfig
  }

  get teamYamlPath(): string {
    return this._teamYamlPath
  }

  /**
   * Startup recovery (11A): rollback stuck orchestrating requirements.
   */
  recover(): number {
    const recovered = this.repo.recoverStuckRequirements()
    if (recovered > 0)
      this.onEvent?.('recovery', { recovered_count: recovered })
    return recovered
  }

  start(): void {
    if (this.leaderLoop?.isRunning) return

    this.recover()

    this.leaderLoop = new LeaderLoop({
      repo: this.repo,
      teamConfig: this.teamConfig,
      resolveProvider: role => this.resolveProviderForRole(role),
      repoPath: this.repoPath,
      defaultBranch: this.defaultBranch,
      outputBuffer: this.outputBuffer,
      onChunk: this.onChunk,
      onEvent: this.onEvent,
    })

    this.leaderLoop.start()
    this.onEvent?.('started')
  }

  async stop(): Promise<void> {
    if (!this.leaderLoop?.isRunning) return
    await this.leaderLoop.stop()
    this.onEvent?.('stopped')
  }

  async dispatchRequirement(requirementId: string): Promise<{ runId: string } | { error: string }> {
    if (!this.leaderLoop) {
      this.leaderLoop = new LeaderLoop({
        repo: this.repo,
        teamConfig: this.teamConfig,
        resolveProvider: role => this.resolveProviderForRole(role),
        repoPath: this.repoPath,
        defaultBranch: this.defaultBranch,
        outputBuffer: this.outputBuffer,
        onChunk: this.onChunk,
        onEvent: this.onEvent,
      })
    }
    return this.leaderLoop.dispatchRequirement(requirementId)
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.repo.findRunById(runId)
    if (!run || run.status !== 'running') return

    if (this.leaderLoop) {
      await this.leaderLoop.cancelCurrentProvider()
    }

    const assignments = this.repo.findAssignmentsByRunId(runId)
    for (const a of assignments) {
      if (a.status === 'pending' || a.status === 'running')
        this.repo.updateAssignmentStatus(a.id, 'cancelled')
    }
    this.repo.updateRunStatus(runId, 'cancelled')
    this.repo.appendEvent(runId, 'run_cancelled')
    this.repo.updateRequirementStatus(run.requirement_id, 'pending')
  }

  updateTeamConfig(config: TeamConfig): void {
    this.teamConfig = config
  }

  // ── Provider factory (1A: independent from WorkflowEngine) ──

  private resolveProviderForRole(role: RoleConfig): AgentProvider {
    const globalProvider = this.settings.get('agent.provider') ?? 'cursor-cli'
    const globalModel = this.settings.get('agent.model') ?? undefined
    const binaryPath = this.settings.get('agent.binaryPath') ?? undefined
    const proxyEnabled = this.settings.get('proxy.enabled') === 'true'
    const proxyUrl = proxyEnabled ? (this.settings.get('proxy.url') ?? undefined) : undefined

    const provider = role.provider ?? globalProvider
    const model = (role.model || undefined) ?? globalModel

    if (proxyUrl) {
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.ALL_PROXY = proxyUrl
    }
    else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.ALL_PROXY
    }

    return new ExternalCliProvider({
      type: provider as 'claude-code' | 'cursor-cli' | 'codex',
      model,
      binaryPath,
      proxyUrl,
      sniProxyPatch: this.options.sniProxyPatch,
    })
  }
}
