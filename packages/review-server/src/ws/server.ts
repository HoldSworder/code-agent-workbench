import { WebSocketServer, type WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { ServerContext } from '../http/context'
import type { ClientMessage, ServerMessage, UserIdentity, ParticipantRole } from './protocol'

const ROLE_VALUES: ParticipantRole[] = ['frontend', 'backend', 'qa', 'host']

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return
  try { socket.send(JSON.stringify(msg)) }
  catch {}
}

function safeParse(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed as ClientMessage
    return null
  }
  catch { return null }
}

export function attachWebSocketServer(httpServer: Server, ctx: ServerContext): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (socket) => {
    ctx.broadcaster.register(socket)

    socket.on('message', (raw) => {
      const msg = safeParse(raw.toString('utf-8'))
      if (!msg) {
        send(socket, { type: 'error', code: 'BAD_MESSAGE', message: '消息格式错误' })
        return
      }
      void handleClientMessage(socket, msg, ctx)
    })

    socket.on('close', () => {
      const { sessionId, identity } = ctx.broadcaster.leaveSession(socket)
      ctx.broadcaster.unregister(socket)
      if (sessionId && identity) {
        ctx.broadcaster.broadcast(sessionId, {
          type: 'participant.left',
          sessionId,
          user: identity,
        })
      }
    })
  })

  return wss
}

async function handleClientMessage(
  socket: WebSocket,
  msg: ClientMessage,
  ctx: ServerContext,
): Promise<void> {
  if (msg.type === 'ping') {
    send(socket, { type: 'pong' })
    return
  }

  if (msg.type === 'auth') {
    if (!msg.larkUserId || !msg.larkUserName) {
      send(socket, { type: 'error', code: 'LARK_IDENTITY_MISSING', message: '缺少飞书身份' })
      socket.close(4002, 'LARK_IDENTITY_MISSING')
      return
    }
    const role = ROLE_VALUES.includes(msg.role) ? msg.role : 'host'
    const identity: UserIdentity = {
      userId: msg.larkUserId,
      userName: msg.larkUserName,
      role,
    }
    ctx.broadcaster.setIdentity(socket, identity)
    return
  }

  const state = ctx.broadcaster.getState(socket)
  if (!state?.identity) {
    send(socket, { type: 'error', code: 'NOT_AUTHENTICATED', message: '请先发送 auth 消息' })
    return
  }

  if (msg.type === 'join') {
    const session = ctx.sessionRepo.findById(msg.sessionId)
    if (!session) {
      send(socket, { type: 'error', code: 'SESSION_NOT_FOUND', message: msg.sessionId })
      return
    }
    ctx.broadcaster.joinSession(socket, msg.sessionId)
    const cache = ctx.specSync.get(msg.sessionId)
    const clarifications = ctx.clarificationRepo.listBySession(msg.sessionId).map(row => ({
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      userName: row.user_name,
      content: row.content,
      parentId: row.parent_id,
      createdAt: row.created_at,
    }))
    let relatedRepos: string[] = []
    try { relatedRepos = JSON.parse(session.related_repos) }
    catch {}
    send(socket, {
      type: 'session.snapshot',
      session: {
        id: session.id,
        requirementId: session.requirement_id,
        requirementTitle: session.requirement_title,
        feishuRequirementUrl: session.feishu_requirement_url,
        feishuSpecDocToken: session.feishu_spec_doc_token,
        feishuSpecDocUrl: session.feishu_spec_doc_url,
        relatedRepos,
        status: session.status,
        hostUserId: session.host_user_id,
        hostUserName: session.host_user_name,
        createdAt: session.created_at,
      },
      spec: cache?.content ?? '',
      specVersion: cache?.version ?? 0,
      clarifications,
      participants: ctx.broadcaster.participantsOf(msg.sessionId),
    })
    ctx.broadcaster.broadcast(msg.sessionId, {
      type: 'participant.joined',
      sessionId: msg.sessionId,
      user: state.identity,
    }, socket)
    return
  }

  if (msg.type === 'leave') {
    ctx.broadcaster.leaveSession(socket)
    ctx.broadcaster.broadcast(msg.sessionId, {
      type: 'participant.left',
      sessionId: msg.sessionId,
      user: state.identity,
    })
    return
  }

  if (msg.type === 'spec.patch') {
    const session = ctx.sessionRepo.findById(msg.sessionId)
    if (!session) {
      send(socket, { type: 'error', code: 'SESSION_NOT_FOUND', message: msg.sessionId })
      return
    }
    const result = ctx.specSync.applyPatch(msg.sessionId, msg.baseVersion, msg.content)
    if (!result.ok && result.conflict) {
      send(socket, {
        type: 'spec.conflict',
        sessionId: msg.sessionId,
        currentVersion: result.currentVersion,
        content: result.content,
      })
      return
    }
    if (!result.ok) {
      send(socket, { type: 'error', code: 'SPEC_NOT_LOADED', message: 'Spec 未加载' })
      return
    }
    ctx.broadcaster.broadcast(msg.sessionId, {
      type: 'spec.updated',
      sessionId: msg.sessionId,
      version: result.currentVersion,
      content: result.content,
      by: { userId: state.identity.userId, userName: state.identity.userName },
    })
    return
  }

  if (msg.type === 'clarify.add') {
    const row = ctx.clarificationRepo.add({
      sessionId: msg.sessionId,
      userId: state.identity.userId,
      userName: state.identity.userName,
      content: msg.content,
      parentId: msg.parentId,
    })
    ctx.broadcaster.broadcast(msg.sessionId, {
      type: 'clarify.added',
      sessionId: msg.sessionId,
      clarification: {
        id: row.id,
        sessionId: row.session_id,
        userId: row.user_id,
        userName: row.user_name,
        content: row.content,
        parentId: row.parent_id,
        createdAt: row.created_at,
      },
    })
    return
  }
}
