import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerContext } from '../context'
import { readBody, sendError, sendJson, readCallerIdentity } from '../util'

interface UpsertBody {
  baseVersion?: number
  content: string
  /** 客户端 force=true 时无视版本号直接覆盖（用于 host 强制同步飞书拉回的内容）。 */
  force?: boolean
}

/**
 * /api/spec/:id/upsert — 由客户端 sidecar 在生成完 dev-spec 或重要修改后调用。
 * 中心服务仅做内存版本递增 + DB 持久化 + ws 广播。
 */
export async function handleSpecRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: ServerContext,
): Promise<boolean> {
  if (!pathname.startsWith('/api/spec/')) return false

  const match = pathname.match(/^\/api\/spec\/([^/]+)\/upsert$/)
  if (match && req.method === 'POST') {
    const sessionId = match[1]
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

    let body: UpsertBody
    try { body = await readBody(req) }
    catch (err) {
      sendError(res, 400, 'INVALID_BODY', err instanceof Error ? err.message : 'invalid body')
      return true
    }
    if (typeof body.content !== 'string') {
      sendError(res, 400, 'INVALID_BODY', 'content 必填')
      return true
    }

    if (body.force) {
      const cur = ctx.specSync.get(sessionId)
      const nextVersion = (cur?.version ?? 0) + 1
      ctx.specSync.load(sessionId, body.content, nextVersion)
      ctx.broadcaster.broadcast(sessionId, {
        type: 'spec.updated',
        sessionId,
        version: nextVersion,
        content: body.content,
        by: { userId: caller.userId, userName: caller.userName },
      })
      sendJson(res, 200, { content: body.content, version: nextVersion, conflict: false })
      return true
    }

    const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : (ctx.specSync.get(sessionId)?.version ?? 0)
    const result = ctx.specSync.applyPatch(sessionId, baseVersion, body.content)
    if (!result.ok && result.conflict) {
      sendJson(res, 409, { conflict: true, currentVersion: result.currentVersion, content: result.content })
      return true
    }
    if (!result.ok) {
      sendError(res, 500, 'SPEC_NOT_LOADED', 'Spec 未加载')
      return true
    }

    ctx.broadcaster.broadcast(sessionId, {
      type: 'spec.updated',
      sessionId,
      version: result.currentVersion,
      content: result.content,
      by: { userId: caller.userId, userName: caller.userName },
    })
    sendJson(res, 200, { content: result.content, version: result.currentVersion, conflict: false })
    return true
  }

  sendError(res, 404, 'NOT_FOUND', `unknown spec route: ${pathname}`)
  return true
}
