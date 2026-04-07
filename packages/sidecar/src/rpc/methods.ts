import type { RpcServer } from './server'
import type Database from 'better-sqlite3'
import { RepoRepository } from '../db/repositories/repo.repo'
import { RequirementRepository } from '../db/repositories/requirement.repo'
import { RepoTaskRepository } from '../db/repositories/repo-task.repo'
import { MessageRepository } from '../db/repositories/message.repo'
import { AgentRunRepository } from '../db/repositories/agent-run.repo'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { spawn as spawnChild } from 'node:child_process'
import type { WorkflowEngine } from '../workflow/engine'
import { createBranch, getChangedFiles, getFileDiff } from '../git/operations'
import { PhaseCommitRepository, INITIAL_PHASE_ID } from '../db/repositories/phase-commit.repo'
import { readTranscript, listSessionsForRepo } from '../transcript/reader'

function changeIdFromRequirementTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const suffix = Date.now().toString(36).slice(-4)

  if (!slug || slug === '-')
    return `change-${suffix}`

  const truncated = slug.slice(0, 40).replace(/-$/, '')
  return `${truncated}-${suffix}`
}

export function registerMethods(
  server: RpcServer,
  db: Database.Database,
  engine: WorkflowEngine,
): void {
  const repoRepo = new RepoRepository(db)
  const reqRepo = new RequirementRepository(db)
  const taskRepo = new RepoTaskRepository(db)
  const msgRepo = new MessageRepository(db)
  const runRepo = new AgentRunRepository(db)
  const settingsRepo = new SettingsRepository(db)
  const commitRepo = new PhaseCommitRepository(db)

  // ── Repo CRUD ──
  server.register('repo.list', async () => repoRepo.findAll())
  server.register('repo.create', async (params) => repoRepo.create(params))
  server.register('repo.delete', async ({ id }) => repoRepo.delete(id))

  server.register('repo.sessions', async ({ repoId }: { repoId: string }) => {
    const repo = repoRepo.findById(repoId)
    if (!repo) throw new Error(`Repo not found: ${repoId}`)
    return listSessionsForRepo(repo.local_path)
  })

  server.register('repo.sessionTranscript', async ({ sessionId }: { sessionId: string }) => {
    const data = readTranscript(sessionId)
    if (!data) return { turns: [], format: 'unknown', filePath: null }
    return { turns: data.turns, format: data.format, filePath: data.filePath }
  })

  // ── Requirement CRUD ──
  server.register('requirement.list', async () => reqRepo.findAll())
  server.register('requirement.create', async (params) => reqRepo.create(params))
  server.register('requirement.get', async ({ id }) => reqRepo.findById(id))

  // ── RepoTask ──
  server.register('task.listByRepo', async ({ repoId }) => taskRepo.findByRepoId(repoId))
  server.register('task.listByRequirement', async ({ requirementId }) =>
    taskRepo.findByRequirementId(requirementId),
  )
  server.register('task.get', async ({ id }) => taskRepo.findById(id))

  server.register(
    'task.create',
    async (params: { requirementId: string, repoId: string }) => {
      const requirement = reqRepo.findById(params.requirementId)
      if (!requirement)
        throw new Error(`Requirement not found: ${params.requirementId}`)
      const repo = repoRepo.findById(params.repoId)
      if (!repo)
        throw new Error(`Repo not found: ${params.repoId}`)

      const changeId = changeIdFromRequirementTitle(requirement.title)
      const branchName = `feature/${changeId}`
      const openspecPath = `openspec/changes/${changeId}`

      try {
        await createBranch(repo.local_path, branchName, repo.default_branch)
      }
      catch {
        // Missing origin or non-git cwd: still persist task for development
      }

      return taskRepo.create({
        requirement_id: requirement.id,
        repo_id: repo.id,
        branch_name: branchName,
        change_id: changeId,
        openspec_path: openspecPath,
        worktree_path: repo.local_path,
      })
    },
  )

  server.register('task.getLiveOutput', async ({ repoTaskId }) => {
    return { output: engine.getLiveOutput(repoTaskId) }
  })

  server.register('task.getLastError', async ({ repoTaskId }) => {
    const run = runRepo.findLastByTask(repoTaskId)
    if (!run || run.status !== 'failed')
      return { error: null }
    return { error: run.error ?? 'Unknown error', phase: run.phase_id, finishedAt: run.finished_at }
  })

  // ── Changed files (git diff against initial commit) ──
  server.register('task.changedFiles', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task) throw new Error(`Task not found: ${repoTaskId}`)
    const baseSha = commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
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
    const baseSha = commitRepo.get(repoTaskId, INITIAL_PHASE_ID)
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
  server.register('workflow.start', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)

    engine.startWorkflow(repoTaskId).catch((err) => {
      process.stderr.write(`[workflow] start failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.confirm', async ({ repoTaskId }) => {
    engine.confirmPhase(repoTaskId).catch((err) => {
      process.stderr.write(`[workflow] confirm failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.feedback', async ({ repoTaskId, feedback }) => {
    engine.provideFeedback(repoTaskId, feedback).catch((err) => {
      process.stderr.write(`[workflow] feedback failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })
  server.register('workflow.triggerEvent', async ({ repoTaskId, eventId, payload }) => {
    engine.triggerEvent(repoTaskId, eventId, payload).catch((err) => {
      process.stderr.write(`[workflow] event ${eventId} failed for ${repoTaskId}: ${err}\n`)
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

  server.register('workflow.rollback', async ({ repoTaskId, targetPhaseId }) => {
    engine.rollbackToPhase(repoTaskId, targetPhaseId).catch((err) => {
      process.stderr.write(`[workflow] rollback to ${targetPhaseId} failed for ${repoTaskId}: ${err}\n`)
    })
    return { ok: true }
  })

  server.register('workflow.phases', async () => {
    return { phases: engine.getPhases() }
  })

  // ── 新增：状态推断 ──
  server.register('workflow.inferPhase', async ({ repoTaskId }) => {
    const task = taskRepo.findById(repoTaskId)
    if (!task)
      throw new Error(`Task not found: ${repoTaskId}`)
    const phase = engine.inferPhase(task.worktree_path, task.openspec_path)
    return { phase }
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

  // ── 新增：依赖检查 ──
  server.register('workflow.checkDependencies', async () => {
    return engine.checkDependencies()
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
  function spawnListModels(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      const child = spawnChild(binary, args, {
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('timeout'))
      }, 30_000)
      child.stdout?.on('data', (d) => { stdout += String(d) })
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('close', () => { clearTimeout(timer); resolve(stdout) })
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

  server.register('agent.listModels', async () => {
    const provider = settingsRepo.get('agent.provider') ?? 'cursor-cli'

    let binary: string
    let args: string[]
    switch (provider) {
      case 'cursor-cli':
        binary = settingsRepo.get('agent.binaryPath') ?? 'cursor'
        args = ['agent', '--list-models']
        break
      case 'claude-code':
        binary = settingsRepo.get('agent.binaryPath') ?? 'claude'
        args = ['--list-models']
        break
      case 'codex':
        binary = settingsRepo.get('agent.binaryPath') ?? 'codex'
        args = ['--list-models']
        break
      default:
        return { models: [] }
    }

    try {
      const stdout = await spawnListModels(binary, args)
      const models = parseModelList(stdout)
      return { models }
    }
    catch {
      return { models: [] }
    }
  })
}
