import { describe, it, expect } from 'vitest'
import { RpcServer } from '../../src/rpc/server'

describe('RpcServer', () => {
  it('dispatches method and returns result', async () => {
    const server = new RpcServer()
    server.register('echo', async (params: any) => params)
    const response = await server.handle(
      '{"jsonrpc":"2.0","id":1,"method":"echo","params":{"msg":"hi"}}',
    )
    const parsed = JSON.parse(response)
    expect(parsed.id).toBe(1)
    expect(parsed.result.msg).toBe('hi')
  })

  it('returns method not found for unknown method', async () => {
    const server = new RpcServer()
    const response = await server.handle(
      '{"jsonrpc":"2.0","id":2,"method":"unknown","params":{}}',
    )
    const parsed = JSON.parse(response)
    expect(parsed.error.code).toBe(-32601)
  })

  it('returns parse error for invalid JSON', async () => {
    const server = new RpcServer()
    const response = await server.handle('not json')
    const parsed = JSON.parse(response)
    expect(parsed.error.code).toBe(-32700)
  })
})
