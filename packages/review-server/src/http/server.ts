import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { errorMessage } from '@code-agent/shared/util'
import { handleSessionsRoute } from './routes/sessions'
import { handleSpecRoute } from './routes/spec'
import { handleAssessmentRoute } from './routes/assessment'
import { parseRequest, sendError, sendJson } from './util'
import type { ServerContext } from './context'

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Lark-User-Id, X-Lark-User-Name, X-Lark-Role')
}

export function buildHttpServer(ctx: ServerContext): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const { pathname } = parseRequest(req)

    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'review-server', uptime: process.uptime() })
        return
      }

      if (await handleSessionsRoute(req, res, pathname, ctx)) return
      if (await handleSpecRoute(req, res, pathname, ctx)) return
      if (await handleAssessmentRoute(req, res, pathname, ctx)) return

      sendError(res, 404, 'NOT_FOUND', `未知路由: ${pathname}`)
    }
    catch (err) {
      const msg = errorMessage(err)
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', msg)
    }
  })
}
