import { ref, onScopeDispose } from 'vue'
import { reviewServerBaseUrl } from './use-review-server'
import type { LarkIdentityResult } from './use-review-server'

export type ParticipantRole = 'frontend' | 'backend' | 'qa' | 'host'

export interface ServerMessage {
  type: string
  [key: string]: unknown
}

export interface ReviewWsHandlers {
  onMessage: (msg: ServerMessage) => void
  onOpen?: () => void
  onClose?: (reason: string) => void
  onError?: (err: Event) => void
}

/**
 * ws 客户端：自动处理 auth 握手 + 心跳。断线重连由调用方控制。
 */
export function useReviewWs(handlers: ReviewWsHandlers) {
  const socket = ref<WebSocket | null>(null)
  const connected = ref(false)
  let pingTimer: ReturnType<typeof setInterval> | null = null

  function buildWsUrl(): string {
    const base = reviewServerBaseUrl.value.replace(/^http/, 'ws').replace(/\/+$/, '')
    return `${base}/ws`
  }

  function send(msg: Record<string, unknown>): void {
    if (socket.value?.readyState === WebSocket.OPEN) {
      socket.value.send(JSON.stringify(msg))
    }
  }

  function connect(identity: NonNullable<LarkIdentityResult['identity']>, role: ParticipantRole): void {
    disconnect()
    const ws = new WebSocket(buildWsUrl())
    socket.value = ws
    ws.onopen = () => {
      connected.value = true
      send({ type: 'auth', larkUserId: identity.userId, larkUserName: identity.userName, role })
      handlers.onOpen?.()
      pingTimer = setInterval(() => send({ type: 'ping' }), 25_000)
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage
        handlers.onMessage(msg)
      }
      catch (err) {
        console.error('[review-ws] parse failed:', err, ev.data)
      }
    }
    ws.onerror = (err) => { handlers.onError?.(err) }
    ws.onclose = (ev) => {
      connected.value = false
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      handlers.onClose?.(ev.reason || `closed: ${ev.code}`)
    }
  }

  function disconnect(): void {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (socket.value) {
      try { socket.value.close() }
      catch {}
      socket.value = null
    }
    connected.value = false
  }

  onScopeDispose(() => disconnect())

  return { connected, connect, disconnect, send }
}
