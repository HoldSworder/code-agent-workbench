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
    case 'repo.delete':
    case 'workflow.confirm':
    case 'workflow.feedback':
    case 'workflow.cancel':
      return undefined as T
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
