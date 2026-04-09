import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import type { RpcServer } from '../rpc/server'
import type { Orchestrator } from './orchestrator'
import { parseTeamConfig } from './team-parser'

interface RoleInput {
  description: string
  provider: string
  model?: string
  prompt_template?: string
  prompt_file?: string
}

interface TeamConfigInput {
  name: string
  description?: string
  polling: { interval_seconds: number, board_filter?: { status?: string } }
  roles: Record<string, RoleInput>
}

const DEFAULT_TEAM_CONFIG: TeamConfigInput = {
  name: 'default-team',
  description: '默认多 Agent 开发团队',
  polling: { interval_seconds: 30, board_filter: { status: 'pending' } },
  roles: {
    leader: {
      description: '分析需求、拆分任务、分配给合适的角色',
      provider: 'claude-code',
      model: '',
      prompt_template: '你是一个技术 Leader。分析需求并拆分为可执行的子任务。\n\n使用 <decision> 标签包裹你的 JSON 决策。',
    },
  },
}

/**
 * 团队配置 RPC — 不依赖 orchestrator 实例，始终注册。
 * 即使 team.yaml 不存在也能读/写/创建。
 */
export function registerTeamConfigMethods(
  rpc: RpcServer,
  teamYamlPath: string,
  getOrchestrator: () => Orchestrator | null,
): void {
  rpc.register('orchestrator.getTeamConfig', async () => {
    const orchestrator = getOrchestrator()
    if (orchestrator) {
      const config = orchestrator.config
      const roles: Record<string, RoleInput> = {}
      for (const [id, role] of Object.entries(config.roles)) {
        roles[id] = {
          description: role.description,
          provider: role.provider,
          model: role.model,
          prompt_template: role.prompt_template,
        }
      }
      return {
        name: config.name,
        description: config.description,
        polling: config.polling,
        roles,
      }
    }

    if (existsSync(teamYamlPath)) {
      const yaml = readFileSync(teamYamlPath, 'utf-8')
      const parsed = parseTeamConfig(yaml, dirname(teamYamlPath))
      const roles: Record<string, RoleInput> = {}
      for (const [id, role] of Object.entries(parsed.roles)) {
        roles[id] = {
          description: role.description,
          provider: role.provider,
          model: role.model,
          prompt_template: role.prompt_template,
        }
      }
      return { name: parsed.name, description: parsed.description, polling: parsed.polling, roles }
    }

    return null
  })

  rpc.register('orchestrator.saveTeamConfig', async (params: TeamConfigInput) => {
    const baseDir = dirname(teamYamlPath)
    const yamlContent = yamlStringify(params)

    // Validate through Zod
    const validated = parseTeamConfig(yamlContent, baseDir)

    writeFileSync(teamYamlPath, yamlContent, 'utf-8')

    const orchestrator = getOrchestrator()
    if (orchestrator)
      orchestrator.updateTeamConfig(validated)

    return { success: true }
  })

  rpc.register('orchestrator.createDefaultConfig', async () => {
    if (existsSync(teamYamlPath))
      throw new Error('team.yaml already exists')

    const yamlContent = yamlStringify(DEFAULT_TEAM_CONFIG)
    writeFileSync(teamYamlPath, yamlContent, 'utf-8')
    return { success: true, path: teamYamlPath }
  })

  rpc.register('orchestrator.getRawTeamYaml', async () => {
    try {
      return { yaml: readFileSync(teamYamlPath, 'utf-8') }
    }
    catch {
      return { yaml: '' }
    }
  })
}

/**
 * Orchestrator 运行时 RPC — 依赖 orchestrator 实例。
 */
export function registerOrchestratorMethods(rpc: RpcServer, orchestrator: Orchestrator): void {
  const repo = orchestrator.repository

  rpc.register('orchestrator.start', async () => {
    orchestrator.start()
    return { success: true }
  })

  rpc.register('orchestrator.stop', async () => {
    await orchestrator.stop()
    return { success: true }
  })

  rpc.register('orchestrator.status', async () => {
    return {
      running: orchestrator.isRunning,
      teamName: orchestrator.config.name,
      roles: Object.keys(orchestrator.config.roles),
    }
  })

  rpc.register('orchestrator.getRuns', async (params: { limit?: number, offset?: number }) => {
    return repo.findAllRuns(params.limit ?? 50, params.offset ?? 0)
  })

  rpc.register('orchestrator.getRunDetail', async (params: { runId: string }) => {
    const run = repo.findRunById(params.runId)
    if (!run) throw new Error(`Run not found: ${params.runId}`)
    const assignments = repo.findAssignmentsByRunId(params.runId)
    return { run, assignments }
  })

  rpc.register('orchestrator.getEvents', async (params: {
    runId?: string
    afterId?: number
    limit?: number
  }) => {
    if (params.runId) {
      return repo.getEvents(params.runId, params.afterId ?? 0, params.limit ?? 100)
    }
    return repo.getAllEvents(params.afterId ?? 0, params.limit ?? 100)
  })

  rpc.register('orchestrator.cancelRun', async (params: { runId: string }) => {
    const run = repo.findRunById(params.runId)
    if (!run) throw new Error(`Run not found: ${params.runId}`)
    if (run.status !== 'running') throw new Error(`Run is not running: ${run.status}`)

    const assignments = repo.findAssignmentsByRunId(params.runId)
    for (const a of assignments) {
      if (a.status === 'pending' || a.status === 'running')
        repo.updateAssignmentStatus(a.id, 'cancelled')
    }
    repo.updateRunStatus(params.runId, 'cancelled')
    repo.appendEvent(params.runId, 'run_cancelled')
    repo.updateRequirementStatus(run.requirement_id, 'pending')
    return { success: true }
  })

  rpc.register('orchestrator.rejectRun', async (params: { runId: string, feedback: string }) => {
    const run = repo.findRunById(params.runId)
    if (!run) throw new Error(`Run not found: ${params.runId}`)

    repo.updateRunRejectFeedback(params.runId, params.feedback)
    repo.appendEvent(params.runId, 'run_rejected', null, JSON.stringify({
      feedback: params.feedback,
    }))
    repo.updateRequirementStatus(run.requirement_id, 'pending')
    return { success: true }
  })

  rpc.register('orchestrator.retryAssignment', async (params: { assignmentId: string }) => {
    const assignment = repo.findAssignmentById(params.assignmentId)
    if (!assignment) throw new Error(`Assignment not found: ${params.assignmentId}`)
    if (assignment.status !== 'failed') throw new Error(`Assignment is not failed: ${assignment.status}`)

    repo.updateAssignmentStatus(params.assignmentId, 'pending')
    return { success: true }
  })

  rpc.register('orchestrator.pauseAssignment', async (params: { assignmentId: string }) => {
    const assignment = repo.findAssignmentById(params.assignmentId)
    if (!assignment) throw new Error(`Assignment not found: ${params.assignmentId}`)
    if (assignment.status !== 'running') throw new Error(`Assignment is not running: ${assignment.status}`)

    repo.updateAssignmentStatus(params.assignmentId, 'cancelled')
    return { success: true }
  })

}
