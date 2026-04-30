import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { ReviewServerClient, encodeHeaderValue } from '../../src/review/client'

describe('encodeHeaderValue', () => {
  it('keeps ASCII-only strings as-is', () => {
    expect(encodeHeaderValue('ou_abc123')).toBe('ou_abc123')
    expect(encodeHeaderValue('host')).toBe('host')
    expect(encodeHeaderValue('John Doe')).toBe('John Doe')
  })

  it('encodes non-ASCII characters via encodeURIComponent', () => {
    expect(encodeHeaderValue('邱卓然')).toBe('%E9%82%B1%E5%8D%93%E7%84%B6')
    expect(encodeHeaderValue('张三 - 后端')).toBe('%E5%BC%A0%E4%B8%89%20-%20%E5%90%8E%E7%AB%AF')
  })
})

describe('ReviewServerClient header encoding', () => {
  const originalFetch = globalThis.fetch
  let lastInit: RequestInit | undefined

  beforeEach(() => {
    lastInit = undefined
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      lastInit = init
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('encodes Chinese userName so fetch does not throw ByteString error', async () => {
    const client = new ReviewServerClient('http://localhost:4100')
    await client.createSession(
      { userId: 'ou_abc', userName: '邱卓然', role: 'host' },
      { requirementId: 'req-1', requirementTitle: 'demo' },
    )
    const headers = lastInit?.headers as Record<string, string>
    expect(headers['X-Lark-User-Id']).toBe('ou_abc')
    expect(headers['X-Lark-User-Name']).toBe('%E9%82%B1%E5%8D%93%E7%84%B6')
    expect(headers['X-Lark-Role']).toBe('host')
    for (const v of Object.values(headers)) {
      expect(/^[\x20-\x7E]*$/.test(v)).toBe(true)
    }
  })
})
