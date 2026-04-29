import type { IncomingMessage, ServerResponse } from 'node:http'

const DEFAULT_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/**
 * 把 IncomingMessage 的请求体读完并按 JSON 解析。
 * 空 body 返回 `{}`；非合法 JSON 抛出 Error。
 */
export async function readBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  }
  catch {
    throw new Error('Invalid JSON body')
  }
}

export interface SendJsonOptions {
  /** 额外 header 合并到响应。 */
  headers?: Record<string, string>
  /** 额外 CORS header（默认仅 Allow-Origin 通配 + 常用方法）。 */
  cors?: Record<string, string>
}

/** 写入 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown, options?: SendJsonOptions): void {
  if (res.headersSent || res.writableEnded) return
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...(options?.cors === undefined ? {} : { ...DEFAULT_CORS_HEADERS, ...options.cors }),
    ...(options?.headers ?? {}),
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

/** 写入错误响应（统一 `{ error: { code, message, detail? } }` 结构）。 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  detail?: unknown,
  options?: SendJsonOptions,
): void {
  sendJson(res, status, { error: { code, message, detail } }, options)
}

export interface ParsedRequest {
  method: string
  pathname: string
  search: URLSearchParams
}

export function parseRequest(req: IncomingMessage): ParsedRequest {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return {
    method: req.method ?? 'GET',
    pathname: url.pathname,
    search: url.searchParams,
  }
}

/** 把常用 CORS header 应用到 ServerResponse；可在 OPTIONS 预检前调用。 */
export function applyCors(res: ServerResponse, override?: Record<string, string>): void {
  const headers = { ...DEFAULT_CORS_HEADERS, ...(override ?? {}) }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
}

/** 提取 client IP（兼容 X-Forwarded-For 数组/字符串）。 */
export function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  if (Array.isArray(forwarded) && forwarded.length > 0) return forwarded[0].split(',')[0].trim()
  const remote = req.socket.remoteAddress ?? 'unknown'
  return remote.replace(/^::ffff:/, '')
}
