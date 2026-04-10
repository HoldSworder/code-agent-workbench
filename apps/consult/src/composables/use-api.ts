const BASE = import.meta.env.DEV ? '' : ''

export interface Repo {
  id: string
  name: string
  local_path: string
  default_branch: string
}

export interface ChatEvent {
  type: 'session' | 'chunk' | 'done' | 'error'
  sessionId?: string
  text?: string
  fullText?: string
  message?: string
}

export async function fetchRepos(): Promise<Repo[]> {
  const res = await fetch(`${BASE}/api/repos`)
  if (!res.ok) throw new Error('Failed to fetch repos')
  return res.json()
}

/**
 * Send a chat message and receive SSE streaming response.
 * Returns the sessionId and a way to abort the request.
 */
export function sendChat(
  opts: { repoId: string, message: string, sessionId?: string },
  onEvent: (event: ChatEvent) => void,
): { abort: () => void } {
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        onEvent({ type: 'error', message: `HTTP ${res.status}` })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6)) as ChatEvent
            onEvent(event)
          } catch { /* ignore malformed SSE lines */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        onEvent({ type: 'error', message: err.message })
      }
    }
  })()

  return { abort: () => controller.abort() }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${BASE}/api/chat/${sessionId}`, { method: 'DELETE' })
}

export interface ServerStatus {
  status: string
  localIp: string | null
  port: number | null
  lanUrl: string | null
}

export async function fetchStatus(): Promise<ServerStatus> {
  const res = await fetch(`${BASE}/api/status`)
  if (!res.ok) throw new Error('Failed to fetch status')
  return res.json()
}
