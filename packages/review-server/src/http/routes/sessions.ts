import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../context'
import type { SessionDto } from '../../ws/protocol'
import { readBody, sendError, sendJson, readCallerIdentity } from '../util'

interface CreateSessionBody {
  requirementId: string
  requirementTitle: string
  feishuRequirementUrl?: string
  feishuSpecDocToken?: string
  feishuSpecDocUrl?: string
  initialSpecMarkdown?: string
  relatedRepos?: string[]
}

function toDto(row: ReturnType<ServerContext['sessionRepo']['create']>): SessionDto {
  let relatedRepos: string[] = []
  try { relatedRepos = JSON.parse(row.related_repos) }
  catch {}
  return {
    id: row.id,
    requirementId: row.requirement_id,
    requirementTitle: row.requirement_title,
    feishuRequirementUrl: row.feishu_requirement_url,
    feishuSpecDocToken: row.feishu_spec_doc_token,
    feishuSpecDocUrl: row.feishu_spec_doc_url,
    relatedRepos,
    status: row.status,
    hostUserId: row.host_user_id,
    hostUserName: row.host_user_name,
    createdAt: row.created_at,
  }
}

export async function handleSessionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: ServerContext,
): Promise<boolean> {
  if (!pathname.startsWith('/api/sessions')) return false

  const sub = pathname.replace('/api/sessions', '')

  if (sub === '' && req.method === 'GET') {
    const list = ctx.sessionRepo.list().map(toDto)
    sendJson(res, 200, { sessions: list })
    return true
  }

  if (sub === '' && req.method === 'POST') {
    const caller = readCallerIdentity(req)
    if (!caller) {
      sendError(res, 401, 'LARK_IDENTITY_MISSING', '缺少 X-Lark-User-Id / X-Lark-User-Name 头')
      return true
    }
    let body: CreateSessionBody
    try { body = await readBody<CreateSessionBody>(req) }
    catch (err) {
      sendError(res, 400, 'INVALID_BODY', err instanceof Error ? err.message : 'invalid body')
      return true
    }
    if (!body.requirementId || !body.requirementTitle) {
      sendError(res, 400, 'INVALID_BODY', 'requirementId 与 requirementTitle 必填')
      return true
    }

    const existing = ctx.sessionRepo.findByRequirementId(body.requirementId)
    if (existing) {
      sendJson(res, 200, { session: toDto(existing), reused: true })
      return true
    }

    const session = ctx.sessionRepo.create({
      requirementId: body.requirementId,
      requirementTitle: body.requirementTitle,
      feishuRequirementUrl: body.feishuRequirementUrl ?? null,
      feishuSpecDocToken: body.feishuSpecDocToken ?? null,
      feishuSpecDocUrl: body.feishuSpecDocUrl ?? null,
      relatedRepos: body.relatedRepos ?? [],
      hostUserId: caller.userId,
      hostUserName: caller.userName,
    })
    if (body.initialSpecMarkdown)
      ctx.specSync.load(session.id, body.initialSpecMarkdown, 0)
    sendJson(res, 201, { session: toDto(session), reused: false })
    return true
  }

  const match = sub.match(/^\/([^/]+)(\/.*)?$/)
  if (!match) {
    sendError(res, 404, 'NOT_FOUND', `unknown route ${pathname}`)
    return true
  }
  const sessionId = match[1]
  const action = match[2] ?? ''

  const session = ctx.sessionRepo.findById(sessionId)
  if (!session) {
    sendError(res, 404, 'SESSION_NOT_FOUND', `会话不存在: ${sessionId}`)
    return true
  }

  if (action === '' && req.method === 'GET') {
    const cache = ctx.specSync.get(sessionId)
    const clarifications = ctx.clarificationRepo.listBySession(sessionId)
    const assessments = ctx.assessmentRepo.listBySession(sessionId)
    sendJson(res, 200, {
      session: toDto(session),
      spec: { content: cache?.content ?? '', version: cache?.version ?? 0 },
      clarifications,
      assessments,
      participants: ctx.broadcaster.participantsOf(sessionId),
    })
    return true
  }

  if (action === '/clarifications' && req.method === 'POST') {
    const caller = readCallerIdentity(req)
    if (!caller) {
      sendError(res, 401, 'LARK_IDENTITY_MISSING', '缺少身份头')
      return true
    }
    const body = await readBody<{ content: string, parentId?: string }>(req)
    if (!body.content) {
      sendError(res, 400, 'INVALID_BODY', 'content 必填')
      return true
    }
    const row = ctx.clarificationRepo.add({
      sessionId,
      userId: caller.userId,
      userName: caller.userName,
      content: body.content,
      parentId: body.parentId,
    })
    ctx.broadcaster.broadcast(sessionId, {
      type: 'clarify.added',
      sessionId,
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
    sendJson(res, 201, { clarification: row })
    return true
  }

  if (action === '/close' && req.method === 'POST') {
    ctx.sessionRepo.updateStatus(sessionId, 'closed')
    ctx.specSync.evict(sessionId)
    sendJson(res, 200, { ok: true })
    return true
  }

  sendError(res, 404, 'NOT_FOUND', `未知会话操作: ${action}`)
  return true
}
