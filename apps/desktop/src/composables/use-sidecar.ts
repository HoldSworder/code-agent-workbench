import { isTauri } from '@tauri-apps/api/core'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import { ref } from 'vue'

let childProcess: Child | null = null
let requestId = 0
const pendingRequests = new Map<
  number,
  {
    resolve: (value: any) => void
    reject: (reason: any) => void
  }
>()
let buffer = ''

export const sidecarReady = ref(false)

function mockRpc<T>(method: string, params: Record<string, any>): T {
  switch (method) {
    case 'requirement.list':
      return [] as T
    case 'repo.list':
      return [] as T
    case 'task.listByRepo':
    case 'task.listByRequirement':
      return [] as T
    case 'message.list':
      return [] as T
    case 'requirement.create':
      return {
        id: `mock-${Date.now()}`,
        title: params.title,
        description: params.description,
        source: params.source,
        source_url: params.source_url ?? null,
        status: 'draft',
        created_at: new Date().toISOString(),
      } as T
    case 'repo.create':
      return {
        id: `mock-${Date.now()}`,
        name: params.name,
        local_path: params.local_path,
        default_branch: params.default_branch,
        agent_provider: null,
        created_at: new Date().toISOString(),
      } as T
    case 'task.create':
      return {
        id: `mock-${Date.now()}`,
        requirement_id: params.requirementId,
        repo_id: params.repoId,
        branch_name: 'feature/mock',
        change_id: 'mock',
        current_phase: 'design',
        phase_status: 'pending',
        openspec_path: '',
        worktree_path: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T
    case 'workflow.start':
    case 'workflow.retry':
    case 'workflow.reset':
    case 'workflow.resetPhase':
    case 'workflow.rollback':
    case 'repo.delete':
    case 'workflow.confirm':
    case 'workflow.feedback':
    case 'workflow.cancel':
      return { ok: true } as T
    case 'workflow.phases':
      return { phases: [
        { id: 'design', name: '设计探索' },
        { id: 'plan', name: '任务规划' },
        { id: 't1-dev', name: 'T1 开发' },
        { id: 'review', name: '代码审查' },
        { id: 'verify', name: '验证' },
        { id: 'mr', name: '创建 MR' },
      ] } as T
    case 'workflow.checkDependencies':
      return { ok: true, missing: [] } as T
    case 'task.getLiveOutput':
      return { output: '' } as T
    case 'task.getLastError':
      return { error: null } as T
    case 'task.changedFiles':
      return { files: [] } as T
    case 'task.fileDiff':
      return { diff: '' } as T
    case 'task.agentRuns':
      return [] as T
    case 'task.sessionTranscript':
      return { turns: [], format: 'unknown', filePath: null } as T
    case 'repo.sessions':
      return [] as T
    case 'repo.sessionTranscript':
      return { turns: [], format: 'unknown', filePath: null } as T
    case 'settings.get':
      return { value: null } as T
    case 'settings.set':
      return { ok: true } as T
    case 'settings.getAll':
      return {} as T
    case 'agent.listModels':
      return { models: [
        { id: 'auto', label: 'Auto' },
        { id: 'sonnet-4-thinking', label: 'Sonnet 4 Thinking' },
        { id: 'gpt-5', label: 'GPT-5' },
      ] } as T
    case 'task.get':
      return {
        id: params.id,
        requirement_id: '',
        repo_id: '',
        branch_name: '',
        change_id: '',
        current_phase: '',
        phase_status: '',
        openspec_path: '',
        worktree_path: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T
    default:
      console.warn(`Sidecar mock: unhandled RPC ${method}`)
      return undefined as T
  }
}

export async function startSidecar(): Promise<void> {
  if (!isTauri()) {
    sidecarReady.value = true
    console.warn('Sidecar: running in mock mode (no Tauri)')
    return
  }

  if (childProcess)
    return

  const command = Command.create('node', [__SIDECAR_SCRIPT__])
  command.stdout.on('data', (line: string) => {
    buffer += line
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const l of lines) {
      if (!l.trim())
        continue
      try {
        const response = JSON.parse(l)
        const pending = pendingRequests.get(response.id)
        if (pending) {
          pendingRequests.delete(response.id)
          if (response.error)
            pending.reject(new Error(response.error.message))
          else
            pending.resolve(response.result)
        }
      }
      catch {
        /* ignore non-JSON lines */
      }
    }
  })

  command.stderr.on('data', (data: string) => {
    if (data.includes('sidecar: ready'))
      sidecarReady.value = true
  })

  childProcess = await command.spawn()
}

export async function rpc<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  if (!isTauri())
    return mockRpc<T>(method, params)

  if (!childProcess)
    throw new Error('Sidecar not started')

  const id = ++requestId
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params })

  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    childProcess!.write(`${request}\n`)
  })
}
