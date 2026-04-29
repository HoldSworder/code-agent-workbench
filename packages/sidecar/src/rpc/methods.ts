import type { RpcServer } from './server'
import type Database from 'better-sqlite3'
import { RepoRepository } from '../db/repositories/repo.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { spawn as spawnChild } from 'node:child_process'
import { CliRunner, buildAgentEnv, buildSniProxyPatch, resolveBinary as resolveSharedBinary, type CliBackend } from '@code-agent/shared/cli'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { stringify as yamlStringify } from 'yaml'
import type { WorkflowEngine } from '../workflow/engine'
import { parseWorkflow } from '../workflow/parser'
import { getChangedFiles, getFileDiff, getMergeBase } from '../git/operations'
import { PhaseCommitRepository, INITIAL_PHASE_ID } from '../db/repositories/phase-commit.repo'
import { readTranscript, listSessionsForRepo } from '../transcript/reader'
import { scanAllSkills, readSkillContent, enableSkill, disableSkill, ENV_LABELS } from '../skill/scanner'
import type { ManageableEnv } from '../skill/scanner'
import { listRemoteSkills, searchRemoteSkills, getRemoteSkillDetail, installRemoteSkill, uninstallRemoteSkill } from '../skill/store'
import {
  scanWorkflowSkills,
  getWorkflowSkill,
  createWorkflowSkill,
  updateWorkflowSkill,
  deleteWorkflowSkill,
  renderWorkflowSkill,
  getWorkflowSkillsRoot,
} from '../workflow-skills/registry'
import type { WorkflowSkillMeta } from '../workflow-skills/types'
import { McpServerRepository } from '../db/repositories/mcp-server.repo'
import type { CreateMcpServerInput, UpdateMcpServerInput, UpsertFeishuProjectInput } from '../db/repositories/mcp-server.repo'
import { McpBindingRepository } from '../db/repositories/mcp-binding.repo'
import { OrchestratorRepository } from '../orchestrator/repository'
import type { ConsultServer } from '../consult/server'
import type { ConsultConfig } from '../consult/types'
import { getAllTools, collectTools } from '../tools/registry'
import { probeMcpServer } from '../mcp/probe'
import { McpOAuthService } from '../mcp/oauth'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = resolve(__dirname, '../../..')

/**
 * 生成初始 changeId（占位符）。
 * 实际语义化英文分支名由 create-branch workflow phase 的 agent 决定，
 * engine 会在该 phase 完成后通过 syncBranchNameFromWorktree 回写。
 */
function changeIdFromRequirement(title: string, description?: string): string {
  const text = (title || description || '').trim()
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const suffix = Date.now().toString(36).slice(-4)

  if (!slug)
    return `change-${suffix}`

  const truncated = slug.slice(0, 40).replace(/-$/, '')
  return `${truncated}-${suffix}`
}

export function registerMethods(
  server: RpcServer,
  db: Database.Database,
  engine: WorkflowEngine,
  workflowPath?: string,
  consultServer?: ConsultServer,
  buildConsultConfig?: () => ConsultConfig,
  workflowsDir?: string,
  dbPath?: string,
): void {
  const repoRepo = new RepoRepository(db)
  const reqRepo = new RequirementRepository(db)
  const taskRepo = new RepoTaskRepository(db)
  const msgRepo = new MessageRepository(db)
  const runRepo = new AgentRunRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const commitRepo = new PhaseCommitRepository(db)
  const mcpServerRepo = new McpServerRepository(db)
  const mcpBindingRepo = new McpBindingRepository(db)
  const orchestratorRepo = new OrchestratorRepository(db)
  const mcpOAuthService = new McpOAuthService()

  function parseJsonSafely<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback
    try {
      return JSON.parse(value) as T
    }
    catch {
      return fallback
    }
  }

  function buildStoredRegistration(srv: ReturnType<typeof mcpServerRepo.findById>) {
    if (!srv?.oauth_client_id) return null
    const raw = parseJsonSafely<Record<string, unknown> | null>(srv.oauth_registration_json, null)
    const redirectUris = Array.isArray(raw?.redirect_uris)
      ? raw.redirect_uris.filter((item): item is string => typeof item === 'string')
      : []
    return {
      clientId: srv.oauth_client_id,
      redirectUris,
      raw,
    }
  }

  function buildProbePayload(serverId: string) {
    const srv = mcpServerRepo.findById(serverId)
    if (!srv) throw new Error(`MCP server not found: ${serverId}`)

    return {
      server: srv,
      target: {
        transport: srv.transport,
        command: srv.command,
        args: JSON.parse(srv.args || '[]') as string[],
        env: JSON.parse(srv.env || '{}') as Record<string, string>,
        url: srv.url,
        headers: JSON.parse(srv.headers || '{}') as Record<string, string>,
        oauth: (srv.oauth_access_token || srv.oauth_refresh_token || srv.oauth_metadata_json || srv.oauth_client_id)
          ? {
              clientId: srv.oauth_client_id,
              accessToken: srv.oauth_access_token,
              refreshToken: srv.oauth_refresh_token,
              expiresAt: srv.oauth_expires_at,
              audience: srv.oauth_audience,
              metadata: parseJsonSafely(srv.oauth_metadata_json, null),
              refreshAccessToken: (input) => mcpOAuthService.refreshToken(input),
              onRefresh: async (tokens) => {
                mcpServerRepo.updateOAuthSession(serverId, {
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                  tokenType: tokens.tokenType,
                  expiresAt: tokens.expiresAt,
                  idToken: tokens.idToken,
                  lastError: null,
                  connectedAt: srv.oauth_connected_at ?? new Date().toISOString(),
                })
              },
            }
          : undefined,
      },
    }
  }

  async function probeAndPersistMcpServer(serverId: string) {
    const { server: srv, target } = buildProbePayload(serverId)
    const testedAt = new Date().toISOString()
    const probe = await probeMcpServer(target)
    let updated = mcpServerRepo.updateProbeResult(serverId, {
      ok: probe.ok,
      error: probe.error ?? null,
      testedAt,
      capabilitiesJson: probe.ok
        ? JSON.stringify({
            protocolVersion: probe.protocolVersion ?? null,
            serverInfo: probe.serverInfo ?? null,
            capabilities: probe.capabilities,
          })
        : null,
      capabilitiesSummary: probe.ok ? JSON.stringify(probe.summary) : null,
    })

    const derivedAuthState = probe.auth?.state ?? (probe.ok ? (srv.oauth_access_token ? 'connected' : 'none') : 'error')
    updated = mcpServerRepo.updateOAuthSession(serverId, {
      metadataJson: probe.auth?.metadata ? JSON.stringify(probe.auth.metadata) : (probe.ok ? null : srv.oauth_metadata_json),
      authState: derivedAuthState,
      lastError: probe.ok ? null : (probe.error ?? null),
      connectedAt: derivedAuthState === 'connected'
        ? (srv.oauth_connected_at ?? new Date().toISOString())
        : srv.oauth_connected_at,
    })

    return { probe: { ...probe, testedAt }, updated }
  }

  // ── Repo CRUD ──
  server.register('repo.list', async () => repoRepo.findAll())
  server.register('repo.create', async (params) => repoRepo.create(params))
  server.register('repo.update', async ({ id, ...input }) => repoRepo.update(id, input))
  server.register('repo.delete', async ({ id }) => repoRepo.delete(id))

  server.register(
    'repo.sessions',
    async ({
      repoId,
      limit,
      offset,
    }: {
      repoId: string
      limit?: number
      offset?: number
    }) => {
      const repo = repoRepo.findById(repoId)
      if (!repo) throw new Error(`Repo not found: ${repoId}`)
      const all = listSessionsForRepo(repo.local_path)
      const total = all.length
      const offsetN = Math.max(0, Math.floor(offset ?? 0))
      if (limit == null || limit <= 0)
        return { items: all, total }
      const cap = Math.min(Math.max(1, limit), 200)
      return { items: all.slice(offsetN, offsetN + cap), total }
    },
  )

  server.register('repo.sessionTranscript', async ({ sessionId }: { sessionId: string }) => {
    const data = readTranscript(sessionId)
    if (!data) return { turns: [], format: 'unknown', filePath: null }
    return { turns: data.turns, format: data.format, filePath: data.filePath }
  })

  // ── Requirement CRUD ──
  server.register('requirement.list', async () => reqRepo.findAll())
  server.register('requirement.create', async (params) => {
    return reqRepo.create(params)
  })
  server.register('requirement.get', async ({ id }) => reqRepo.findById(id))
  server.register('requirement.update', async ({ id, data }: { id: string, data: { title?: string, description?: string, doc_url?: string | null, mode?: string } }) => {
    reqRepo.update(id, data)
    return reqRepo.findById(id)
  })
  server.register('requirement.updateStatus', async ({ id, status }: { id: string, status: string }) => {
    const req = reqRepo.findById(id)
    if (!req) throw new Error(`Requirement not found: ${id}`)
    const ALLOWED: Record<string, string[]> = {
      draft: ['pending'],
      pending: ['draft'],
    }
    if (!ALLOWED[req.status]?.includes(status))
      throw new Error(`Cannot transition from ${req.status} to ${status}`)
    reqRepo.updateStatus(id, status)
    return reqRepo.findById(id)
  })

  server.register('requirement.archive', async ({ id }: { id: string }) => {
    const req = reqRepo.findById(id)
    if (!req) throw new Error(`Requirement not found: ${id}`)
    if (req.status === 'archived') return reqRepo.findById(id)
    const tasks = taskRepo.findByRequirementId(id)
    if (tasks.length > 0 && !tasks.every(t => t.phase_status === 'completed'))
      throw new Error('Cannot archive: not all tasks are completed')
    reqRepo.updateStatus(id, 'archived')
    return reqRepo.findById(id)
  })

  server.register('requirement.delete', async ({ id }) => {
    await engine.cancelRequirementFetch(id).catch(() => {})
    const tasks = taskRepo.findByRequirementId(id)
    for (const task of tasks) {
      await engine.cancelCurrentAgent(task.id).catch(() => {})
    }
    taskRepo.deleteByRequirementId(id)
    orchestratorRepo.deleteByRequirementId(id)
    reqRepo.delete(id)
    return { ok: true }
  })

  server.register('requirement.startFetch', async ({ requirementId, mcpServerIds }: { requirementId: string, mcpServerIds?: string[] }) => {
    const req = reqRepo.findById(requirementId)
    if (!req) throw new Error(`Requirement not found: ${requirementId}`)
    if (req.source !== 'feishu' || !req.source_url)
      throw new Error(`Requirement ${requirementId} is not a feishu requirement or has no source_url`)
    reqRepo.updateStatus(requirementId, 'fetching')
    reqRepo.updateFetchError(requirementId, null)
    engine.startRequirementFetch(requirementId, mcpServerIds).catch((err) => {
      process.stderr.write(`[workflow] startRequirementFetch failed for ${requirementId}: ${err}\n`)
    })
    return { ok: true }
  })

  server.register('requirement.getLiveOutput', async ({ requirementId }: { requirementId: string }) => {
    return { output: engine.getRequirementLiveOutput(requirementId) }
  })

  server.register('requirement.retryFetch', async ({ requirementId, mcpServerIds }: { requirementId: string, mcpServerIds?: string[] }) => {
    const req = reqRepo.findById(requirementId)
    if (!req || req.status !== 'fetch_failed')
      throw new Error(`Requirement ${requirementId} is not in fetch_failed state`)
    reqRepo.updateStatus(requirementId, 'fetching')
    reqRepo.updateFetchError(requirementId, null)
    engine.startRequirementFetch(requirementId, mcpServerIds).catch((err) => {
      process.stderr.write(`[workflow] retryFetch failed for ${requirementId}: ${err}\n`)
    })
    return { ok: true }
  })

  server.register('requirement.listSessions', async ({ requirementId }: { requirementId: string }) => {
    const workDir = join(homedir(), '.code-agent', 'requirement-fetch', requirementId)
    return { items: listSessionsForRepo(workDir) }
  })

  server.register('requirement.sessionTranscript', async ({ sessionId }: { sessionId: string }) => {
    const data = readTranscript(sessionId)
    if (!data) return { turns: [], format: 'unknown', filePath: null }
    return { turns: data.turns, format: data.format, filePath: data.filePath }
  })

  // ── RepoTask ──
  server.register('task.listByRepo', async ({ repoId }) => taskRepo.findByRepoId(repoId))
  server.register('task.listByRequirement', async ({ requirementId }) =>
    taskRepo.findByRequirementId(requirementId),
  )
  server.register('task.get', async ({ id }) => taskRepo.findById(id))

  server.register(
    'task.create',
    async (params: { requirementId: string, repoId: string, workflowId?: string }) => {
      const requirement = reqRepo.findById(params.requirementId)
      if (!requirement)
        throw new Error(`Requirement not found: ${params.requirementId}`)
      const repo = repoRepo.findById(params.repoId)
      if (!repo)
        throw new Error(`Repo not found: ${params.repoId}`)

      const changeId = changeIdFromRequirement(requirement.title, requirement.description)
      const branchName = `feature/${changeId}`
      const openspecPath = `openspec/changes/${changeId}`

      return taskRepo.create({
        requirement_id: requirement.id,
        repo_id: repo.id,
        branch_name: branchName,
        change_id: changeId,
        openspec_path: openspecPath,
        worktree_path: repo.local_path,
        workflow_id: params.workflowId,
      })
    },
  )

  server.register('task.getLiveOutput', async ({ repoTaskId }) => {
    return {
      output: engine.getLiveOutput(repoTaskId),
      activity: engine.getLiveActivity(repoTaskId),
    }
  })

  server.register('task.getLastError', async ({ repoTaskId }) => {
    const run = runRepo.findLastByTask(repoTaskId)
    if (!run || run.status !== 'failed')
      return { error: null }
    return { error: run.error ?? 'Unknown error', phase: run.phase_id, finishedAt: run.finished_at }
  })

  // ── Changed files (git diff against initial commit) ──

  async function resolveBaseSha(repoTaskId: string, worktreePath: string): Promise<string | null> {
    const stored = commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
    if (stored) return stored
    try {
      const sha = await getMergeBase(worktreePath)
      if (sha) {
        commitRepo.save(repoTaskId, INITIAL_PHASE_ID, sha)
        return sha
      }
    }
    catch {}
    return null
  }

  server.register('task.changedFiles', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)
    const baseSha = await resolveBaseSha(repoTaskId, task.worktree_path)
    try {
      const files = await getChangedFiles(task.worktree_path, baseSha)
      return { files }
    }
    catch {
      return { files: [] }
    }
  })

  server.register('task.fileDiff', async ({ repoTaskId, filePath }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)
    const baseSha = await resolveBaseSha(repoTaskId, task.worktree_path)
    try {
      const diff = await getFileDiff(task.worktree_path, baseSha, filePath)
      return { diff }
    }
    catch {
      return { diff: '' }
    }
  })

  // ── Agent runs & transcripts ──
  server.register('task.agentRuns', async ({ repoTaskId }) => {
    return runRepo.findByTaskId(repoTaskId)
  })

  server.register('task.sessionTranscript', async ({ sessionId }: { sessionId: string }) => {
    const data = readTranscript(sessionId)
    if (!data) return { turns: [], format: 'unknown', filePath: null }
    return { turns: data.turns, format: data.format, filePath: data.filePath }
  })

  // ── Conversation ──
  server.register('message.list', async ({ taskId, phaseId }) =>
    msgRepo.findByTaskAndPhase(taskId, phaseId),
  )
  server.register('message.listAll', async ({ taskId }) =>
    msgRepo.findByTask(taskId),
  )

  // ── Workflow actions ──
  server.register('workflow.listAll', async () => {
    return { workflows: engine.listWorkflows() }
  })

  server.register('workflow.start', async ({ repoTaskId, workflowId }: { repoTaskId: string, workflowId?: string }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    engine.startWorkflow(repoTaskId, workflowId).catch((err) => {
      process.stderr.write(`[workflow] start failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.confirm', async ({ repoTaskId, advance }) => {
    engine.confirmPhase(repoTaskId, { advance: !!advance }).catch((err) => {
      process.stderr.write(`[workflow] confirm failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.confirmAndAdvance', async ({ repoTaskId }) => {
    engine.confirmAndExecute(repoTaskId).catch((err) => {
      process.stderr.write(`[workflow] confirmAndAdvance failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.getAdvanceOptions', async ({ repoTaskId }) => {
    return engine.getAdvanceOptions(repoTaskId)
  })
  server.register('workflow.confirmAndAdvanceToPhase', async ({ repoTaskId, targetPhaseId, input }) => {
    engine.confirmAndAdvanceToPhase(repoTaskId, targetPhaseId, input).catch((err) => {
      process.stderr.write(`[workflow] confirmAndAdvanceToPhase failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.suspend', async ({ repoTaskId }) => {
    await engine.suspendTask(repoTaskId)
    return { ok: true }
  })
  server.register('workflow.resume', async ({ repoTaskId }) => {
    await engine.resumeTask(repoTaskId)
    return { ok: true }
  })
  server.register('workflow.feedback', async ({ repoTaskId, feedback, planMode }) => {
    engine.provideFeedback(repoTaskId, feedback, planMode).catch((err) => {
      process.stderr.write(`[workflow] feedback failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.rollbackToStage', async ({ repoTaskId, targetStageId }) => {
    engine.rollbackToStage(repoTaskId, targetStageId).catch((err) => {
      process.stderr.write(`[workflow] rollback to stage ${targetStageId} failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.retry', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    engine.retryPhase(repoTaskId).catch((err) => {
      process.stderr.write(`[workflow] retry failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.cancel', async ({ repoTaskId }) => {
    await engine.cancelCurrentAgent(repoTaskId)
    return { ok: true }
  })

  server.register('workflow.reset', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)
    await engine.resetTask(repoTaskId)
    return { ok: true }
  })

  server.register('workflow.resetPhase', async ({ repoTaskId }) => {
    engine.resetCurrentPhase(repoTaskId).catch((err) => {
      process.stderr.write(`[workflow] resetPhase failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })

  server.register('workflow.rollback', async ({ repoTaskId, targetStageId, targetPhaseId }) => {
    engine.rollbackToPhase(repoTaskId, targetStageId, targetPhaseId).catch((err) => {
      process.stderr.write(`[workflow] rollback to ${targetStageId}/${targetPhaseId} failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.rollbackPaused', async ({ repoTaskId, targetStageId, targetPhaseId }) => {
    engine.rollbackToPhase(repoTaskId, targetStageId, targetPhaseId, { pauseAfterRollback: true }).catch((err) => {
      process.stderr.write(`[workflow] rollbackPaused to ${targetStageId}/${targetPhaseId} failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.rollbackToMessage', async ({ repoTaskId, messageId }) => {
    engine.rollbackToMessage(repoTaskId, messageId).catch((err) => {
      process.stderr.write(`[workflow] rollbackToMessage ${messageId} failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.retryFromPrompt', async ({ repoTaskId, messageId }) => {
    engine.retryFromPrompt(repoTaskId, messageId).catch((err) => {
      process.stderr.write(`[workflow] retryFromPrompt ${messageId} failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })

  server.register('workflow.phases', async ({ workflowId }: { workflowId?: string } = {}) => {
    return { stages: engine.getStagesAndPhases(workflowId) }
  })

  server.register('workflow.reload', async ({ workflowId }: { workflowId?: string } = {}) => {
    let yamlPath: string | undefined
    if (!workflowId || workflowId === 'default') {
      yamlPath = workflowPath
    }
    else if (workflowsDir) {
      yamlPath = resolve(workflowsDir, workflowId, 'workflow.yaml')
    }
    if (!yamlPath || !existsSync(yamlPath))
      throw new Error(`Workflow YAML not found for "${workflowId ?? 'default'}"`)
    const yaml = readFileSync(yamlPath, 'utf-8')
    engine.reloadWorkflow(workflowId ?? 'default', yaml)
    return { ok: true }
  })

  server.register('workflow.requirementPhases', async () => {
    return { phases: engine.getRequirementPhases() }
  })

  server.register('workflow.executeRequirementPhase', async ({ repoTaskId, phaseId, userMessage }) => {
    engine.executeRequirementPhase(repoTaskId, phaseId, userMessage).catch((err) => {
      process.stderr.write(`[workflow] executeRequirementPhase failed for ${repoTaskId}/${phaseId}: ${err}\n`)
    })
    return { ok: true }
  })

  // ── 新增：状态推断 ──
  server.register('workflow.inferPhase', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)
    const wf = engine.getWorkflowConfig(task.workflow_id)
    return engine.inferStageAndPhase(task.worktree_path, task.openspec_path, wf)
  })

  // ── 新增：触发语路由 ──
  server.register('workflow.routeTrigger', async ({ userInput }) => {
    const target = engine.routeTrigger(userInput)
    return { target }
  })

  // ── 新增：自动路由并执行 ──
  server.register('workflow.routeAndExecute', async ({ repoTaskId, userInput }) => {
    const target = engine.routeTrigger(userInput)
    engine.routeAndExecute(repoTaskId, userInput).catch((err) => {
      process.stderr.write(`[workflow] routeAndExecute failed for ${repoTaskId}: ${err}\n`)
    })
    return { executedTarget: target }
  })

  // ── 完整配置读写 ──
  server.register('workflow.getFullConfig', async ({ workflowId }: { workflowId?: string } = {}) => {
    return engine.getWorkflowConfig(workflowId)
  })

  server.register('workflow.getRawYaml', async ({ workflowId }: { workflowId?: string } = {}) => {
    return { yaml: engine.getRawYaml(workflowId) }
  })

  server.register('workflow.resolveSkill', async ({ skillPath }: { skillPath: string }) => {
    return { content: engine.resolveSkill(skillPath) }
  })

  server.register('workflow.previewPrompt', async ({ repoTaskId, phaseId }: { repoTaskId: string, phaseId: string }) => {
    return { prompt: engine.previewPhasePrompt(repoTaskId, phaseId) }
  })

  server.register('workflow.previewPromptTemplate', async ({ phaseId, workflowId }: { phaseId: string, workflowId?: string }) => {
    return { prompt: engine.previewPhasePromptTemplate(phaseId, workflowId) }
  })

  server.register('workflow.getPhaseEnabledMap', async ({ workflowId }: { workflowId?: string } = {}) => {
    return engine.getPhaseEnabledMap(workflowId)
  })

  server.register('workflow.setPhaseEnabled', async ({ phaseId, enabled }: { phaseId: string, enabled: boolean }) => {
    engine.setPhaseEnabled(phaseId, enabled)
    return { ok: true }
  })

  server.register('workflow.getPhaseAgentMap', async ({ workflowId }: { workflowId?: string } = {}) => {
    return engine.getPhaseAgentMap(workflowId)
  })

  server.register('workflow.setPhaseAgent', async ({ phaseId, agent, model }: { phaseId: string, agent?: string | null, model?: string | null }) => {
    engine.setPhaseAgent(phaseId, agent, model)
    return { ok: true }
  })

  server.register('workflow.saveConfig', async ({ config }: { config: Record<string, any> }) => {
    const validated = parseWorkflow(yamlStringify(config))
    const yaml = yamlStringify(validated, { lineWidth: 120 })
    if (workflowPath)
      writeFileSync(workflowPath, yaml, 'utf-8')
    engine.reloadConfig(yaml)
    return { ok: true }
  })

  // ── 依赖检查 ──
  server.register('workflow.checkDependencies', async () => {
    return engine.checkDependencies()
  })

  // ── Workflow Tools ──

  server.register('workflow.listTools', async () => {
    return getAllTools().map((t) => {
      let scriptPath: string | null = null
      try {
        scriptPath = t.resolveScript({} as any)
      }
      catch { /* path resolution may fail without real ctx */ }
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        injectionRule: t.injectionRule,
        usage: t.usage,
        scriptPath,
      }
    })
  })

  server.register('workflow.getInjectedTools', async ({ repoTaskId, phaseId }: { repoTaskId: string, phaseId: string }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task || !dbPath) return []
    return collectTools({
      db,
      repoTaskId,
      currentPhaseId: phaseId,
      worktreePath: task.worktree_path,
      dbPath,
    }).map(t => ({ id: t.id }))
  })

  // ── UI Elements ──

  server.register('ui.getPending', async ({ taskId }: { taskId: string }) => {
    const task = taskRepo.findById(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    const all = engine.readUIElements(task.worktree_path)
    return all.filter((e: any) => e.response == null)
  })

  server.register('ui.getAll', async ({ taskId }: { taskId: string }) => {
    const task = taskRepo.findById(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    return engine.readUIElements(task.worktree_path)
  })

  server.register('ui.submitResponse', async ({ taskId, elementId, data }: { taskId: string, elementId: string, data: unknown }) => {
    engine.submitUIResponse(taskId, elementId, data)
    return { ok: true }
  })

  // ── Skills ──
  server.register('skill.scan', async () => {
    return { skills: scanAllSkills(), envLabels: ENV_LABELS }
  })

  server.register('skill.readContent', async ({ skillPath }: { skillPath: string }) => {
    return { content: readSkillContent(skillPath) }
  })

  server.register('skill.enable', async ({ dirName, realDir, env }: { dirName: string, realDir: string, env: ManageableEnv }) => {
    enableSkill(dirName, realDir, env)
    return { ok: true }
  })

  server.register('skill.disable', async ({ dirName, env }: { dirName: string, env: ManageableEnv }) => {
    disableSkill(dirName, env)
    return { ok: true }
  })

  // ── Workflow Skills（根级 skills/ 目录，工作流节点引用） ──
  server.register('workflowSkill.list', async () => {
    const skills = scanWorkflowSkills()
    return {
      root: getWorkflowSkillsRoot(),
      skills: skills.map(s => ({ ...s.meta, dir: s.dir })),
    }
  })

  server.register('workflowSkill.get', async ({ id }: { id: string }) => {
    const s = getWorkflowSkill(id)
    if (!s) return { found: false, meta: null, content: '' }
    return { found: true, meta: s.meta, content: s.content, dir: s.dir }
  })

  server.register('workflowSkill.create', async (input: {
    id: string
    name: string
    description?: string
    content?: string
    inputs?: WorkflowSkillMeta['inputs']
    mcp_dependencies?: string[]
    tags?: string[]
  }) => {
    const s = createWorkflowSkill(input)
    return { meta: s.meta, content: s.content, dir: s.dir }
  })

  server.register('workflowSkill.update', async (input: {
    id: string
    name?: string
    description?: string
    content?: string
    inputs?: WorkflowSkillMeta['inputs']
    mcp_dependencies?: string[]
    tags?: string[]
  }) => {
    const s = updateWorkflowSkill(input)
    return { meta: s.meta, content: s.content, dir: s.dir }
  })

  server.register('workflowSkill.delete', async ({ id }: { id: string }) => {
    deleteWorkflowSkill(id)
    return { ok: true }
  })

  server.register('workflowSkill.preview', async ({ id, vars }: { id: string, vars?: Record<string, string> }) => {
    const r = renderWorkflowSkill(id, vars ?? {})
    if (!r) return { found: false, content: '', missingVars: [] }
    return { found: true, content: r.content, missingVars: r.missingVars, meta: r.meta }
  })

  // ── Skill Store ──
  server.register('skillStore.list', async ({ apiBase, cursor }: { apiBase: string, cursor?: string }) => {
    return listRemoteSkills(apiBase, cursor)
  })

  server.register('skillStore.search', async ({ apiBase, query }: { apiBase: string, query: string }) => {
    return searchRemoteSkills(apiBase, query)
  })

  server.register('skillStore.detail', async ({ apiBase, slug, source }: { apiBase: string, slug: string, source?: string }) => {
    return getRemoteSkillDetail(apiBase, slug, source)
  })

  server.register('skillStore.install', async ({ apiBase, slug, version, source }: { apiBase: string, slug: string, version?: string, source?: string }) => {
    return installRemoteSkill(apiBase, slug, version, source)
  })

  server.register('skillStore.uninstall', async ({ slug }: { slug: string }) => {
    return { removed: uninstallRemoteSkill(slug) }
  })

  // ── MCP Management ──
  server.register('mcp.list', async () => mcpServerRepo.findAll())

  server.register('mcp.create', async (params: CreateMcpServerInput) => {
    const created = mcpServerRepo.create(params)
    const { updated } = await probeAndPersistMcpServer(created.id)
    return updated
  })

  server.register('mcp.update', async ({ id, ...input }: { id: string } & UpdateMcpServerInput) =>
    mcpServerRepo.update(id, input),
  )

  server.register('mcp.delete', async ({ id }: { id: string }) => {
    mcpServerRepo.delete(id)
    return { ok: true }
  })

  server.register('mcp.toggle', async ({ id }: { id: string }) => mcpServerRepo.toggle(id))

  server.register('mcp.test', async ({ id }: { id: string }) => {
    const srv = mcpServerRepo.findById(id)
    if (!srv) return { ok: false, error: 'Server not found' }
    const { probe } = await probeAndPersistMcpServer(id)
    return probe
  })

  server.register('mcp.oauthStart', async ({ id }: { id: string }) => {
    const srv = mcpServerRepo.findById(id)
    if (!srv) throw new Error(`MCP server not found: ${id}`)
    if (srv.transport === 'stdio') throw new Error('OAuth login is only supported for HTTP/SSE MCP servers')
    if (!srv.url) throw new Error('No URL configured')
    const started = await mcpOAuthService.startAuthorization({
      mcpUrl: srv.url,
      scope: srv.oauth_scope,
      audience: srv.oauth_audience,
      tokenEndpointAuthMethod: srv.oauth_token_endpoint_auth_method,
      registration: buildStoredRegistration(srv),
    })
    mcpServerRepo.updateOAuthRegistration(id, {
      clientId: started.registration.clientId,
      registrationJson: JSON.stringify(started.registration.raw ?? {
        client_id: started.registration.clientId,
        redirect_uris: started.registration.redirectUris,
      }),
      redirectMode: started.redirectMode,
    })
    mcpServerRepo.updateOAuthSession(id, {
      metadataJson: JSON.stringify(started.metadata),
      authState: 'required',
      redirectMode: started.redirectMode,
      lastError: null,
    })
    return started
  })

  server.register('mcp.oauthPoll', async ({ id, requestId }: { id: string, requestId: string }) => {
    const srv = mcpServerRepo.findById(id)
    if (!srv) throw new Error(`MCP server not found: ${id}`)

    const result = mcpOAuthService.pollAuthorization(requestId)
    if (result.status === 'success' && result.tokens) {
      if (result.registration) {
        mcpServerRepo.updateOAuthRegistration(id, {
          clientId: result.registration.clientId,
          registrationJson: JSON.stringify(result.registration.raw ?? {
            client_id: result.registration.clientId,
            redirect_uris: result.registration.redirectUris,
          }),
        })
      }
      const updated = mcpServerRepo.updateOAuthSession(id, {
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        tokenType: result.tokens.tokenType,
        expiresAt: result.tokens.expiresAt,
        idToken: result.tokens.idToken,
        metadataJson: JSON.stringify(result.metadata),
        authState: 'connected',
        lastError: null,
        connectedAt: new Date().toISOString(),
      })
      return { ...result, server: updated }
    }

    if (result.status === 'error') {
      const updated = mcpServerRepo.updateOAuthSession(id, {
        metadataJson: JSON.stringify(result.metadata),
        authState: 'error',
        lastError: result.error ?? 'OAuth authorization failed',
      })
      return { ...result, server: updated }
    }

    return result
  })

  server.register('mcp.oauthComplete', async ({ url }: { url: string }) => {
    await mcpOAuthService.completeAuthorization(url)
    return { ok: true }
  })

  server.register('mcp.oauthDisconnect', async ({ id }: { id: string }) => {
    return mcpServerRepo.clearOAuthSession(id)
  })

  server.register('mcp.getBindings', async ({ stageId, phaseId }: { stageId: string, phaseId: string }) =>
    mcpBindingRepo.findByPhase(stageId, phaseId),
  )

  server.register('mcp.getAllBindings', async () => mcpBindingRepo.findAll())

  server.register('mcp.setBindings', async ({ stageId, phaseId, mcpServerIds }: { stageId: string, phaseId: string, mcpServerIds: string[] }) => {
    mcpBindingRepo.setBindings(stageId, phaseId, mcpServerIds)
    return { ok: true }
  })

  server.register('mcp.setFeishuProject', async ({ id }: { id: string }) => {
    return mcpServerRepo.setFeishuProject(id)
  })
  server.register('mcp.unsetFeishuProject', async () => {
    mcpServerRepo.unsetFeishuProject()
    return { ok: true }
  })
  server.register('mcp.getFeishuProject', async () => {
    return mcpServerRepo.findFeishuProject()
  })

  // 快捷配置：用固定逻辑 id 落库 + 自动置 is_feishu_project 标记。
  // 落库后立刻探测一次（与 mcp.create 行为一致），便于卡片显示连通状态。
  server.register('mcp.upsertFeishuProject', async (params: UpsertFeishuProjectInput) => {
    const upserted = mcpServerRepo.upsertFeishuProject(params)
    try {
      const { updated } = await probeAndPersistMcpServer(upserted.id)
      return updated
    }
    catch {
      return upserted
    }
  })

  server.register('mcp.deleteFeishuProject', async () => {
    return mcpServerRepo.deleteFeishuProject()
  })

  // ── Settings ──
  server.register('settings.get', async ({ key }) => {
    return { value: settingsRepo.get(key) }
  })
  server.register('settings.set', async ({ key, value }) => {
    settingsRepo.set(key, value)
    return { ok: true }
  })
  server.register('settings.getAll', async () => {
    return settingsRepo.getAll()
  })

  // ── Agent models ──
  const sniPatchPath = resolve(projectRoot, 'scripts', 'agent-socks5-patch.cjs')

  function buildModelListEnv(): Record<string, string> {
    const proxyEnabled = settingsRepo.get('proxy.enabled') === 'true'
    const proxyUrl = proxyEnabled ? settingsRepo.get('proxy.url') : null
    const useSniPatch = !!proxyUrl && existsSync(sniPatchPath)
    return buildAgentEnv({
      proxyUrl: useSniPatch ? null : proxyUrl,
      sniProxyPatch: useSniPatch ? buildSniProxyPatch({ scriptPath: sniPatchPath, proxyUrl: proxyUrl! }) : null,
      extraEnv: { NO_COLOR: '1', TERM: 'dumb' },
    })
  }

  function parseModelList(raw: string): { id: string, label: string }[] {
    const strip = (s: string) => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\[\d*[GK]/g, '').trim()
    return raw.split('\n')
      .map(strip)
      .filter(l => l && l.includes(' - '))
      .map((l) => {
        const [id, ...rest] = l.split(' - ')
        return { id: id.trim(), label: rest.join(' - ').trim() }
      })
      .filter(m => m.id && m.id !== 'Available models')
  }

  function resolveBinary(provider: string): string | null {
    const KNOWN: CliBackend[] = ['cursor-cli', 'claude-code', 'codex']
    if (!KNOWN.includes(provider as CliBackend)) return null
    const globalProvider = settingsRepo.get('agent.provider') ?? 'cursor-cli'
    const override = provider === globalProvider ? settingsRepo.get('agent.binaryPath') : null
    return resolveSharedBinary(provider as CliBackend, override)
  }

  function fetchCodexModels(binary: string): Promise<{ id: string, label: string }[]> {
    return new Promise((resolve, reject) => {
      const child = spawnChild(binary, ['app-server'], {
        env: buildModelListEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })

      let buf = ''
      let initDone = false
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('codex app-server timeout'))
      }, 15_000)

      child.stdout?.on('data', (d) => {
        buf += String(d)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (!initDone && msg.id === 0 && msg.result) {
              initDone = true
              child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'model/list', id: 1, params: {} }) + '\n')
            }
            else if (msg.id === 1) {
              clearTimeout(timer)
              child.kill('SIGTERM')
              const data: any[] = msg.result?.data ?? []
              resolve(data.filter((m: any) => !m.hidden).map((m: any) => ({
                id: m.id,
                label: m.displayName || m.description || '',
              })))
            }
          }
          catch { /* ignore non-JSON lines */ }
        }
      })
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('close', () => { clearTimeout(timer); resolve([]) })

      child.stdin?.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 0,
        params: { clientInfo: { name: 'code-agent', version: '1.0' }, capabilities: {} },
      }) + '\n')
    })
  }

  server.register('agent.listModels', async (params?: { provider?: string }) => {
    const provider = params?.provider || settingsRepo.get('agent.provider') || 'cursor-cli'
    const binary = resolveBinary(provider)
    if (!binary) return { models: [] }

    try {
      if (provider === 'codex') {
        const models = await fetchCodexModels(binary)
        return { models }
      }
      const result = await CliRunner.run({
        binary,
        args: ['--list-models'],
        cwd: process.cwd(),
        env: buildModelListEnv(),
        useStreamJson: false,
        timeoutMs: 30_000,
        activityTimeoutMs: 30_000,
      })
      if (result.status !== 'success') return { models: [] }
      const models = parseModelList(result.output)
      return { models }
    }
    catch {
      return { models: [] }
    }
  })

  // ── Consultation mode ──
  if (consultServer && buildConsultConfig) {
    server.register('consult.start', async ({ port }: { port?: number } = {}) => {
      const config = buildConsultConfig()
      consultServer.updateConfig(config)
      await consultServer.start(port ?? config.port)
      return consultServer.getStatus()
    })

    server.register('consult.stop', async () => {
      await consultServer.stop()
      return { ok: true }
    })

    server.register('consult.status', async () => {
      return consultServer.getStatus()
    })

    server.register('consult.listSessions', async () => {
      return consultServer.listSessions()
    })

    server.register('consult.getSessionMessages', async ({ sessionId }: { sessionId: string }) => {
      return consultServer.getSessionMessages(sessionId)
    })
  }
}
