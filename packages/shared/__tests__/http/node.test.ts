import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { extractClientIp, parseRequest, readBody, sendError, sendJson } from '../../src/http/node'

function fakeRes() {
  const headers: Record<string, string> = {}
  let writtenStatus = 0
  let writtenBody = ''
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(k: string, v: string) { headers[k] = v },
    writeHead(status: number, h?: Record<string, string>) {
      writtenStatus = status
      if (h) Object.assign(headers, h)
      this.headersSent = true
    },
    end(body?: string) {
      writtenBody = body ?? ''
      this.writableEnded = true
    },
  }
  return { res: res as unknown as ServerResponse, headers, get status() { return writtenStatus }, get body() { return writtenBody } }
}

describe('readBody', () => {
  it('解析合法 JSON', async () => {
    const stream = Readable.from([Buffer.from('{"a":1}')]) as unknown as IncomingMessage
    const body = await readBody<{ a: number }>(stream)
    expect(body).toEqual({ a: 1 })
  })

  it('空 body 返回 {}', async () => {
    const stream = Readable.from([]) as unknown as IncomingMessage
    expect(await readBody(stream)).toEqual({})
  })

  it('非法 JSON 抛错', async () => {
    const stream = Readable.from([Buffer.from('not json')]) as unknown as IncomingMessage
    await expect(readBody(stream)).rejects.toThrow('Invalid JSON body')
  })
})

describe('sendJson', () => {
  it('写入 JSON content-type 和 status', () => {
    const r = fakeRes()
    sendJson(r.res, 200, { ok: true })
    expect(r.status).toBe(200)
    expect(r.body).toBe('{"ok":true}')
    expect(r.headers['Content-Type']).toContain('application/json')
  })

  it('cors 选项注入 CORS header', () => {
    const r = fakeRes()
    sendJson(r.res, 201, { ok: 1 }, { cors: {} })
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*')
  })

  it('headersSent 时静默跳过', () => {
    const r = fakeRes()
    ;(r.res as { headersSent: boolean }).headersSent = true
    expect(() => sendJson(r.res, 200, { ok: true })).not.toThrow()
    expect(r.body).toBe('')
  })
})

describe('sendError', () => {
  it('包装为 { error: { code, message, detail } }', () => {
    const r = fakeRes()
    sendError(r.res, 400, 'BAD', 'invalid', { field: 'x' })
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'BAD', message: 'invalid', detail: { field: 'x' } } })
    expect(r.status).toBe(400)
  })
})

describe('parseRequest', () => {
  it('解析 method / pathname / search', () => {
    const req = { url: '/api/foo?x=1&y=2', method: 'POST', headers: { host: 'localhost:3000' } } as unknown as IncomingMessage
    const out = parseRequest(req)
    expect(out.method).toBe('POST')
    expect(out.pathname).toBe('/api/foo')
    expect(out.search.get('x')).toBe('1')
  })
})

describe('extractClientIp', () => {
  it('优先取 x-forwarded-for 第一个', () => {
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '9.9.9.9' } } as unknown as IncomingMessage
    expect(extractClientIp(req)).toBe('1.2.3.4')
  })

  it('剥离 IPv4-mapped ::ffff: 前缀', () => {
    const req = { headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } } as unknown as IncomingMessage
    expect(extractClientIp(req)).toBe('127.0.0.1')
  })

  it('无信息返回 unknown', () => {
    const req = { headers: {}, socket: {} } as unknown as IncomingMessage
    expect(extractClientIp(req)).toBe('unknown')
  })
})
