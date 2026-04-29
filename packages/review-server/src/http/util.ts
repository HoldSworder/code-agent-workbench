import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  readBody,
  parseRequest,
  sendJson as sharedSendJson,
  sendError as sharedSendError,
} from '@code-agent/shared/http'
import type { ParsedRequest, SendJsonOptions } from '@code-agent/shared/http'

const REVIEW_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Lark-User-Id, X-Lark-User-Name, X-Lark-Role',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}

function withReviewCors(options?: SendJsonOptions): SendJsonOptions {
  return { ...(options ?? {}), cors: { ...REVIEW_CORS, ...(options?.cors ?? {}) } }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sharedSendJson(res, status, body, withReviewCors())
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, detail?: unknown): void {
  sharedSendError(res, status, code, message, detail, withReviewCors())
}

export { readBody, parseRequest }
export type { ParsedRequest }

export interface CallerIdentity {
  userId: string
  userName: string
  role: string
}

export function readCallerIdentity(req: IncomingMessage): CallerIdentity | null {
  const userId = req.headers['x-lark-user-id']
  const userName = req.headers['x-lark-user-name']
  const role = req.headers['x-lark-role']
  if (typeof userId !== 'string' || !userId) return null
  if (typeof userName !== 'string' || !userName) return null
  return {
    userId,
    userName,
    role: typeof role === 'string' ? role : 'host',
  }
}
