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

/**
 * HTTP 头按规范是 ByteString，中文姓名等非 ASCII 字符必须由客户端先做
 * `encodeURIComponent`。这里 try-decode：解码成功则用解码值，解码失败（旧客户端
 * 或非 URL 编码内容）则保留原值，保证向后兼容。
 */
function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

export function readCallerIdentity(req: IncomingMessage): CallerIdentity | null {
  const userId = req.headers['x-lark-user-id']
  const userName = req.headers['x-lark-user-name']
  const role = req.headers['x-lark-role']
  if (typeof userId !== 'string' || !userId) return null
  if (typeof userName !== 'string' || !userName) return null
  return {
    userId: decodeHeaderValue(userId),
    userName: decodeHeaderValue(userName),
    role: typeof role === 'string' && role ? decodeHeaderValue(role) : 'host',
  }
}
