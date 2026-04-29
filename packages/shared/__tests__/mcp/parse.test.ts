import { describe, expect, it } from 'vitest'
import { parseMcpResponseText } from '../../src/mcp/parse'

describe('parseMcpResponseText', () => {
  it('优先按整体 JSON 解析', () => {
    const r = parseMcpResponseText('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
    expect(r.result.ok).toBe(true)
  })

  it('解析 SSE event-stream 中的首条带 result 的 payload', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n'
    const r = parseMcpResponseText(sse)
    expect(r.result).toEqual({ x: 1 })
  })

  it('SSE 多 data 行拼接', () => {
    const sse = 'data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"y":2}}\n\n'
    const r = parseMcpResponseText(sse)
    expect(r.result).toEqual({ y: 2 })
  })

  it('空响应抛错', () => {
    expect(() => parseMcpResponseText('   ')).toThrow('Empty MCP response body')
  })

  it('完全无法解析时抛错', () => {
    expect(() => parseMcpResponseText('garbage non json')).toThrow('Unable to parse MCP response payload')
  })
})
