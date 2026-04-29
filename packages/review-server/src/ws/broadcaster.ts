import type { WebSocket } from 'ws'
import type { ServerMessage, UserIdentity } from './protocol'

interface ClientState {
  socket: WebSocket
  identity: UserIdentity | null
  sessionId: string | null
}

/**
 * 维护所有 ws 连接，按 sessionId 房间广播。
 */
export class Broadcaster {
  private clients = new Map<WebSocket, ClientState>()

  register(socket: WebSocket): void {
    this.clients.set(socket, { socket, identity: null, sessionId: null })
  }

  unregister(socket: WebSocket): UserIdentity | null {
    const state = this.clients.get(socket)
    this.clients.delete(socket)
    return state?.identity ?? null
  }

  setIdentity(socket: WebSocket, identity: UserIdentity): void {
    const state = this.clients.get(socket)
    if (state) state.identity = identity
  }

  joinSession(socket: WebSocket, sessionId: string): void {
    const state = this.clients.get(socket)
    if (state) state.sessionId = sessionId
  }

  leaveSession(socket: WebSocket): { sessionId: string | null, identity: UserIdentity | null } {
    const state = this.clients.get(socket)
    if (!state) return { sessionId: null, identity: null }
    const sessionId = state.sessionId
    state.sessionId = null
    return { sessionId, identity: state.identity }
  }

  getState(socket: WebSocket): ClientState | null {
    return this.clients.get(socket) ?? null
  }

  participantsOf(sessionId: string): UserIdentity[] {
    const seen = new Set<string>()
    const result: UserIdentity[] = []
    for (const state of this.clients.values()) {
      if (state.sessionId !== sessionId || !state.identity) continue
      if (seen.has(state.identity.userId)) continue
      seen.add(state.identity.userId)
      result.push(state.identity)
    }
    return result
  }

  /**
   * 广播给指定会话内的所有客户端，可选排除某个连接。
   */
  broadcast(sessionId: string, msg: ServerMessage, excludeSocket?: WebSocket): void {
    const payload = JSON.stringify(msg)
    for (const state of this.clients.values()) {
      if (state.sessionId !== sessionId) continue
      if (excludeSocket && state.socket === excludeSocket) continue
      if (state.socket.readyState === state.socket.OPEN) {
        try { state.socket.send(payload) }
        catch (err) { process.stderr.write(`broadcast send failed: ${err}\n`) }
      }
    }
  }

  /**
   * 全局广播（用于 gate 状态变化）。
   */
  broadcastAll(msg: ServerMessage): void {
    const payload = JSON.stringify(msg)
    for (const state of this.clients.values()) {
      if (state.socket.readyState === state.socket.OPEN) {
        try { state.socket.send(payload) }
        catch {}
      }
    }
  }

  send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return
    try { socket.send(JSON.stringify(msg)) }
    catch {}
  }
}
