import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../context'
import { readBody, sendError, sendJson, readCallerIdentity } from '../util'

type Role = 'frontend' | 'backend' | 'qa'

interface ResultsBody {
  results: Array<{ role: Role, points: number, rationale: string }>
}

const ROLE_SET = new Set<Role>(['frontend', 'backend', 'qa'])

/**
 * /api/assessment/:id/results — 由 sidecar 客户端在 AI 评估 + 飞书写入 + MCP 回填后调用。
 * 中心服务仅做 DB 持久化 + ws 广播 + 标记会话 confirmed。
 */
export async function handleAssessmentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: ServerContext,
): Promise<boolean> {
  if (!pathname.startsWith('/api/assessment/')) return false

  const matchPost = pathname.match(/^\/api\/assessment\/([^/]+)\/results$/)
  if (matchPost && req.method === 'POST') {
    const sessionId = matchPost[1]
    const session = ctx.sessionRepo.findById(sessionId)
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', `会话不存在: ${sessionId}`)
      return true
    }
    const caller = readCallerIdentity(req)
    if (!caller) {
      sendError(res, 401, 'LARK_IDENTITY_MISSING', '缺少身份头')
      return true
    }

    let body: ResultsBody
    try { body = await readBody(req) }
    catch (err) {
      sendError(res, 400, 'INVALID_BODY', err instanceof Error ? err.message : 'invalid body')
      return true
    }
    if (!Array.isArray(body.results) || body.results.length === 0) {
      sendError(res, 400, 'INVALID_BODY', 'results 必填')
      return true
    }

    const cleaned = body.results
      .filter(r => r && ROLE_SET.has(r.role) && Number.isFinite(r.points))
      .map(r => ({ role: r.role, points: Number(r.points), rationale: String(r.rationale ?? '') }))

    for (const r of cleaned) {
      ctx.assessmentRepo.save({
        sessionId,
        role: r.role,
        points: r.points,
        rationale: r.rationale,
        assessorUserId: caller.userId,
      })
    }

    ctx.sessionRepo.updateStatus(sessionId, 'confirmed')
    ctx.broadcaster.broadcast(sessionId, { type: 'assessment.completed', sessionId, results: cleaned })
    ctx.broadcaster.broadcast(sessionId, { type: 'session.confirmed', sessionId })

    sendJson(res, 200, { results: cleaned })
    return true
  }

  if (pathname.match(/^\/api\/assessment\/[^/]+$/) && req.method === 'GET') {
    const id = pathname.split('/').pop()!
    sendJson(res, 200, { results: ctx.assessmentRepo.listBySession(id) })
    return true
  }

  sendError(res, 404, 'NOT_FOUND', `unknown assessment route: ${pathname}`)
  return true
}
