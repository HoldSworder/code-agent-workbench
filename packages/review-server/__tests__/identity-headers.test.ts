import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { readCallerIdentity } from '../src/http/util'

function makeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('readCallerIdentity header decoding', () => {
  it('decodes URL-encoded Chinese userName from sidecar', () => {
    const req = makeReq({
      'x-lark-user-id': 'ou_abc',
      'x-lark-user-name': '%E9%82%B1%E5%8D%93%E7%84%B6',
      'x-lark-role': 'host',
    })
    expect(readCallerIdentity(req)).toEqual({ userId: 'ou_abc', userName: '邱卓然', role: 'host' })
  })

  it('falls back to raw value for legacy ASCII clients', () => {
    const req = makeReq({
      'x-lark-user-id': 'ou_abc',
      'x-lark-user-name': 'John Doe',
    })
    expect(readCallerIdentity(req)).toEqual({ userId: 'ou_abc', userName: 'John Doe', role: 'host' })
  })

  it('keeps raw value when header is not valid percent-encoding', () => {
    const req = makeReq({
      'x-lark-user-id': 'ou_abc',
      'x-lark-user-name': '50% off',
    })
    const id = readCallerIdentity(req)
    expect(id?.userName).toBe('50% off')
  })

  it('returns null when required headers are missing', () => {
    expect(readCallerIdentity(makeReq({}))).toBeNull()
    expect(readCallerIdentity(makeReq({ 'x-lark-user-id': 'ou_abc' }))).toBeNull()
  })
})
