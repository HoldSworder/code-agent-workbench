import { describe, expect, it } from 'vitest'
import {
  extractActivityEntry,
  extractSessionId,
  extractStreamText,
  extractTokenUsage,
  normalizeLine,
  parseJsonOutput,
  parseStreamResult,
  stripThinkTags,
} from '../../src/cli/stream-parse'

describe('normalizeLine', () => {
  it('剥离 stdout: 前缀', () => {
    expect(normalizeLine('stdout: {"a":1}')).toBe('{"a":1}')
  })

  it('剥离 \\r 与首尾空白', () => {
    expect(normalizeLine('  {"a":1}\r')).toBe('{"a":1}')
  })

  it('空行返回空串', () => {
    expect(normalizeLine('   \r\n')).toBe('')
  })
})

describe('stripThinkTags', () => {
  it('移除 <think>/<thinking> 标签', () => {
    expect(stripThinkTags('hello <think>internal</think>world')).toBe('hello internalworld')
  })

  it('归并 3+ 换行', () => {
    expect(stripThinkTags('a\n\n\n\nb')).toBe('a\n\nb')
  })
})

describe('extractStreamText', () => {
  it('cursor-cli delta', () => {
    const r = extractStreamText(JSON.stringify({ type: 'assistant', subtype: 'delta', text: 'hi' }))
    expect(r).toEqual({ text: 'hi', isComplete: false })
  })

  it('claude-code stream_event text_delta', () => {
    const r = extractStreamText(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hi' } } }))
    expect(r.text).toBe('hi')
  })

  it('Anthropic content_block_delta', () => {
    const r = extractStreamText(JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }))
    expect(r.text).toBe('hi')
  })

  it('完整 assistant 消息标记 isComplete', () => {
    const evt = { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
    const r = extractStreamText(JSON.stringify(evt))
    expect(r).toEqual({ text: 'done', isComplete: true })
  })

  it('非 JSON 返回空', () => {
    expect(extractStreamText('not json')).toEqual({ text: '', isComplete: false })
  })
})

describe('extractActivityEntry', () => {
  it('cursor-cli delta 生成 ✍️ 活动条目', () => {
    const e = extractActivityEntry(JSON.stringify({ type: 'assistant', subtype: 'delta', text: 'hello' }))
    expect(e).toMatch(/✍️ hello/)
  })

  it('tool_use 生成 🔧 条目', () => {
    const e = extractActivityEntry(JSON.stringify({ type: 'tool_use', name: 'Read', input: { path: '/a' } }))
    expect(e).toMatch(/🔧 Tool: Read/)
  })

  it('result 生成 🏁', () => {
    expect(extractActivityEntry(JSON.stringify({ type: 'result' }))).toMatch(/🏁/)
  })

  it('非 JSON 返回 null', () => {
    expect(extractActivityEntry('garbage')).toBeNull()
  })
})

describe('extractSessionId', () => {
  it('支持 session_id / sessionId / message.session_id', () => {
    expect(extractSessionId(JSON.stringify({ session_id: 'a' }))).toBe('a')
    expect(extractSessionId(JSON.stringify({ sessionId: 'b' }))).toBe('b')
    expect(extractSessionId(JSON.stringify({ message: { session_id: 'c' } }))).toBe('c')
  })

  it('无 session id 返回 null', () => {
    expect(extractSessionId(JSON.stringify({ type: 'foo' }))).toBeNull()
  })
})

describe('parseStreamResult', () => {
  it('优先 result 字段', () => {
    const out = [
      JSON.stringify({ type: 'assistant', subtype: 'delta', text: 'partial' }),
      JSON.stringify({ type: 'result', result: 'final answer' }),
    ].join('\n')
    expect(parseStreamResult(out)).toBe('final answer')
  })

  it('累加 deltas', () => {
    const out = [
      JSON.stringify({ type: 'assistant', subtype: 'delta', text: 'hello ' }),
      JSON.stringify({ type: 'assistant', subtype: 'delta', text: 'world' }),
    ].join('\n')
    expect(parseStreamResult(out)).toBe('hello world')
  })
})

describe('extractTokenUsage', () => {
  it('从 result 中读取 total_tokens', () => {
    const out = JSON.stringify({ type: 'result', total_tokens: 1234 })
    expect(extractTokenUsage(out)).toBe(1234)
  })

  it('从 result.usage.total_tokens 读取', () => {
    const out = JSON.stringify({ type: 'result', usage: { total_tokens: 99 } })
    expect(extractTokenUsage(out)).toBe(99)
  })

  it('未匹配到返回 undefined', () => {
    expect(extractTokenUsage('{"type":"foo"}')).toBeUndefined()
  })
})

describe('parseJsonOutput', () => {
  it('解析 codex 风格 result/usage', () => {
    const out = JSON.stringify({ result: 'hi', usage: { total_tokens: 7 } })
    expect(parseJsonOutput(out)).toEqual({ text: 'hi', tokenUsage: 7 })
  })

  it('非 JSON 原样返回 text', () => {
    expect(parseJsonOutput('plain text').text).toBe('plain text')
  })
})
