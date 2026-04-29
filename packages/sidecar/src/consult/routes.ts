import type { IncomingMessage, ServerResponse } from 'node:http'
import type Database from 'better-sqlite3'
import { extractClientIp, readBody, sendJson } from '@code-agent/shared/http'
import type { ConsultChatHandler } from './chat-handler'
import { RepoRepository } from '../db/repositories/repo.repo'

export interface RouteContext {
  db: Database.Database
  chatHandler: ConsultChatHandler
  getLocalIp: () => string | null
  getPort: () => number
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => void | Promise<void>

interface Route {
  method: string
  pattern: RegExp
  handler: Handler
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, status, data)
}

function error(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, status, { error: message })
}

function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
  return readBody<Record<string, any>>(req)
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/repos$/,
    async handler(_req, res, ctx) {
      const repoRepo = new RepoRepository(ctx.db)
      const repos = repoRepo.findAll()
      json(res, repos)
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/chat$/,
    async handler(req, res, ctx) {
      const body = await parseBody(req)
      const { repoId, message, sessionId } = body

      if (!message || typeof message !== 'string')
        return error(res, 'message is required')

      let session = sessionId ? ctx.chatHandler.getSession(sessionId) : null

      if (!session) {
        if (!repoId) return error(res, 'repoId is required for new sessions')
        const repoRepo = new RepoRepository(ctx.db)
        const repo = repoRepo.findById(repoId)
        if (!repo) return error(res, `Repo not found: ${repoId}`, 404)
        session = ctx.chatHandler.createSession(repoId, repo.local_path, extractClientIp(req))
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Session-Id': session.id,
      })
      res.flushHeaders()
      req.socket.setNoDelay(true)

      res.write(`data: ${JSON.stringify({ type: 'session', sessionId: session.id })}\n\n`)

      const onChunk = (text: string) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`)
        }
      }

      try {
        const result = await ctx.chatHandler.chat(session.id, message, onChunk)
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'done', fullText: result.assistantMessage })}\n\n`)
        }
      } catch (err: any) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
        }
      }

      if (!res.writableEnded) res.end()
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/chat\/([^/]+)\/history$/,
    async handler(req, res, ctx) {
      const match = req.url!.match(/^\/api\/chat\/([^/]+)\/history$/)
      const sessionId = match?.[1]
      if (!sessionId) return error(res, 'sessionId is required')

      const session = ctx.chatHandler.getSession(sessionId)
      if (!session) return error(res, 'Session not found', 404)

      json(res, { sessionId: session.id, repoId: session.repoId, messages: session.messages })
    },
  },

  {
    method: 'DELETE',
    pattern: /^\/api\/chat\/([^/]+)$/,
    async handler(req, res, ctx) {
      const match = req.url!.match(/^\/api\/chat\/([^/]+)$/)
      const sessionId = match?.[1]
      if (!sessionId) return error(res, 'sessionId is required')

      ctx.chatHandler.deleteSession(sessionId)
      json(res, { ok: true })
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/status$/,
    async handler(_req, res, ctx) {
      const localIp = ctx.getLocalIp()
      const port = ctx.getPort()
      json(res, {
        status: 'running',
        localIp,
        port,
        lanUrl: localIp ? `http://${localIp}:${port}` : null,
      })
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/sessions$/,
    async handler(_req, res, ctx) {
      json(res, ctx.chatHandler.listSessions())
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/sessions\/([^/]+)\/messages$/,
    async handler(req, res, ctx) {
      const match = req.url!.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      const sessionId = match?.[1]
      if (!sessionId) return error(res, 'sessionId is required')

      const messages = ctx.chatHandler.getSessionMessages(sessionId)
      if (!messages) return error(res, 'Session not found', 404)

      json(res, messages)
    },
  },
]

export function matchRoute(method: string, url: string): Route | null {
  const path = url.split('?')[0]
  for (const route of routes) {
    if (route.method === method && route.pattern.test(path))
      return route
  }
  return null
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const url = req.url ?? '/'
  if (!url.startsWith('/api/')) return false

  const route = matchRoute(req.method ?? 'GET', url)
  if (!route) {
    error(res, 'Not found', 404)
    return true
  }

  try {
    await route.handler(req, res, ctx)
  } catch (err: any) {
    if (!res.headersSent) error(res, err.message ?? 'Internal error', 500)
  }
  return true
}
