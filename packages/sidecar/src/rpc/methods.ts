import type { RpcServer } from './server'
import type Database from 'better-sqlite3'
import { RepoRepository } from '../db/repositories/repo.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { spawn as spawnChild } from 'node:child_process'
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
import { McpServerRepository } from '../db/repositories/mcp-server.repo'
import type { CreateMcpServerInput, UpdateMcpServerInput } from '../db/repositories/mcp-server.repo'
import { McpBindingRepository } from '../db/repositories/mcp-binding.repo'
import { OrchestratorRepository } from '../orchestrator/repository'
import type { ConsultServer } from '../consult/server'
import type { ConsultConfig } from '../consult/types'

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
    engine.suspendTask(repoTaskId).catch((err) => {
      process.stderr.write(`[workflow] suspend failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.resume', async ({ repoTaskId }) => {
    await engine.resumeTask(repoTaskId)
    return { ok: true }
  })
  server.register('workflow.feedback', async ({ repoTaskId, feedback }) => {
    engine.provideFeedback(repoTaskId, feedback).catch((err) => {
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

  server.register('mcp.create', async (params: CreateMcpServerInput) => mcpServerRepo.create(params))

  server.register('mcp.update', async ({ id, ...input }: { id: string } & UpdateMcpServerInput) =>
    mcpServerRepo.update(id, input),
  )

  server.register('mcp.delete', async ({ id }: { id: string }) => {
    mcpServerRepo.delete(id)
    return { ok: true }
  })

  server.register('mcp.toggle', async ({ id }: { id: string }) => mcpServerRepo.toggle(id))

  server.register('mcp.test', async ({ id }: { id: string }): Promise<{ ok: boolean, error?: string, tools?: number }> => {
    const srv = mcpServerRepo.findById(id)
    if (!srv) return { ok: false, error: 'Server not found' }

    if (srv.transport === 'stdio') {
      const command = srv.command
      if (!command) return { ok: false, error: 'No command configured' }
      const args = JSON.parse(srv.args || '[]') as string[]
      const envVars = JSON.parse(srv.env || '{}') as Record<string, string>
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill()
          resolve({ ok: false, error: 'Timed out after 15s — process started but MCP handshake did not complete' })
        }, 15_000)

        const child = spawnChild(command, args, {
          env: { ...process.env, ...envVars },
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        let stdout = ''

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

        const initRequest = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'code-agent-test', version: '0.1.0' } } })
        child.stdin?.write(initRequest + '\n')

        child.on('error', (err) => {
          clearTimeout(timeout)
          resolve({ ok: false, error: `Failed to spawn: ${err.message}` })
        })

        const checkInitResponse = () => {
          try {
            const lines = stdout.split('\n').filter(Boolean)
            for (const line of lines) {
              const resp = JSON.parse(line)
              if (resp.id === 1 && resp.result) {
                clearTimeout(timeout)
                child.kill()
                return resolve({ ok: true, tools: undefined })
              }
              if (resp.error) {
                clearTimeout(timeout)
                child.kill()
                return resolve({ ok: false, error: resp.error.message || 'MCP init rejected' })
              }
            }
          } catch { /* partial data, keep waiting */ }
        }

        child.stdout?.on('data', () => checkInitResponse())

        child.on('close', (code) => {
          clearTimeout(timeout)
          if (code !== 0 && code !== null) {
            resolve({ ok: false, error: `Process exited with code ${code}` })
          }
        })
      })
    }

    const targetUrl = srv.url
    if (!targetUrl) return { ok: false, error: 'No URL configured' }
    const headers = JSON.parse(srv.headers || '{}') as Record<string, string>

    try {
      const resp = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'code-agent-test', version: '0.1.0' } } }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` }
      const body = await resp.json()
      if (body.error) return { ok: false, error: body.error.message || 'MCP init rejected' }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Connection failed' }
    }
  })

  server.register('mcp.getBindings', async ({ stageId, phaseId }: { stageId: string, phaseId: string }) =>
    mcpBindingRepo.findByPhase(stageId, phaseId),
  )

  server.register('mcp.getAllBindings', async () => mcpBindingRepo.findAll())

  server.register('mcp.setBindings', async ({ stageId, phaseId, mcpServerIds }: { stageId: string, phaseId: string, mcpServerIds: string[] }) => {
    mcpBindingRepo.setBindings(stageId, phaseId, mcpServerIds)
    return { ok: true }
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
    const env: Record<string, string> = {}
    const parentNodeOptions = process.env.NODE_OPTIONS ?? ''
    const hasSniPatchInParent = parentNodeOptions.includes('agent-socks5-patch')

    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue
      if (k === 'NODE_OPTIONS' && !hasSniPatchInParent) continue
      if (k.startsWith('npm_')) continue
      if (k.startsWith('ELECTRON_')) continue
      env[k] = v
    }
    env.NO_COLOR = '1'
    env.TERM = 'dumb'

    if (hasSniPatchInParent) {
      delete env.HTTP_PROXY
      delete env.HTTPS_PROXY
      delete env.ALL_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
      return env
    }

    const proxyEnabled = settingsRepo.get('proxy.enabled') === 'true'
    const proxyUrl = proxyEnabled ? settingsRepo.get('proxy.url') : null
    if (!proxyUrl) return env

    if (existsSync(sniPatchPath)) {
      let socks5Host = '127.0.0.1'
      let socks5Port = '7890'
      try {
        const url = new URL(proxyUrl)
        socks5Host = url.hostname || '127.0.0.1'
        socks5Port = url.port || '7890'
      }
      catch {
        const match = proxyUrl.match(/:(\d+)\s*$/)
        if (match) socks5Port = match[1]
      }
      env.NODE_OPTIONS = `--require "${sniPatchPath}"`
      env.AGENT_SOCKS5_HOST = socks5Host
      env.AGENT_SOCKS5_PORT = socks5Port
      delete env.HTTP_PROXY
      delete env.HTTPS_PROXY
      delete env.ALL_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
    }
    else {
      env.HTTP_PROXY = proxyUrl
      env.HTTPS_PROXY = proxyUrl
      env.ALL_PROXY = proxyUrl
      env.http_proxy = proxyUrl
      env.https_proxy = proxyUrl
      env.all_proxy = proxyUrl
    }

    return env
  }

  function spawnListModels(binary: string, args: string[]): Promise<string> {
    return new Promise((res, reject) => {
      let stdout = ''
      const child = spawnChild(binary, args, {
        env: buildModelListEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('timeout'))
      }, 30_000)
      child.stdout?.on('data', (d) => { stdout += String(d) })
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('close', () => { clearTimeout(timer); res(stdout) })
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

  const defaultBinaries: Record<string, string> = {
    'cursor-cli': 'agent',
    'claude-code': 'claude',
    'codex': 'codex',
  }

  function resolveBinary(provider: string): string | null {
    const fallback = defaultBinaries[provider]
    if (!fallback) return null
    const globalProvider = settingsRepo.get('agent.provider') ?? 'cursor-cli'
    if (provider === globalProvider) {
      return settingsRepo.get('agent.binaryPath') || fallback
    }
    return fallback
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
      const stdout = await spawnListModels(binary, ['--list-models'])
      const models = parseModelList(stdout)
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
