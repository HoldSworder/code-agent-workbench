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

export async function startSidecar(): Promise<void> {
  if (childProcess)
    return

  const command = Command.sidecar('binaries/sidecar')
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
  if (!childProcess)
    throw new Error('Sidecar not started')

  const id = ++requestId
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params })

  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    childProcess!.write(`${request}\n`)
  })
}
