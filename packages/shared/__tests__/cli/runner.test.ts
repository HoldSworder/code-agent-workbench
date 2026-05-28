import { describe, expect, it } from 'vitest'
import { CliRunner } from '../../src/cli/runner'

const NODE = process.execPath

describe('CliRunner.run（基于真实 spawn / node 子进程）', () => {
  it('成功路径：cat-style 子进程返回 stream-json，正确解析为最终文本', async () => {
    const stream = [
      { type: 'assistant', subtype: 'delta', text: 'hello ' },
      { type: 'assistant', subtype: 'delta', text: 'world' },
      { type: 'result', result: 'hello world', total_tokens: 42 },
    ].map(o => JSON.stringify(o)).join('\n')

    const script = `process.stdout.write(${JSON.stringify(stream)} + '\\n'); process.exit(0)`
    const result = await CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: true,
      timeoutMs: 5_000,
      activityTimeoutMs: 5_000,
    })
    expect(result.status).toBe('success')
    expect(result.output).toBe('hello world')
    expect(result.tokenUsage).toBe(42)
    expect(result.exitCode).toBe(0)
  })

  it('signal 触发后子进程被强制结束并返回 cancelled', async () => {
    const ctl = new AbortController()
    const script = 'setTimeout(() => {}, 60_000)'

    const promise = CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: true,
      timeoutMs: 30_000,
      activityTimeoutMs: 30_000,
      signal: ctl.signal,
    })
    setTimeout(() => ctl.abort(), 50)
    const result = await promise
    expect(result.status).toBe('cancelled')
    expect(result.error).toContain('Cancelled')
  }, 10_000)

  it('binary 不存在返回 ENOENT 友好错误', async () => {
    const result = await CliRunner.run({
      binary: '/no/such/binary-cli-runner-test',
      args: [],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: false,
      timeoutMs: 2_000,
      activityTimeoutMs: 2_000,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('not found')
  })

  it('useStreamJson=false 时 stdout 原样返回为 output', async () => {
    const script = `process.stdout.write(${JSON.stringify(JSON.stringify({ result: 'plain', usage: { total_tokens: 5 } }))})`
    const result = await CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: false,
      timeoutMs: 5_000,
      activityTimeoutMs: 5_000,
    })
    expect(result.status).toBe('success')
    expect(result.output).toBe('plain')
    expect(result.tokenUsage).toBe(5)
  })

  it('activity 超时时 kill 子进程并标记 failed', async () => {
    const script = 'setTimeout(() => {}, 60_000)'
    const result = await CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: true,
      timeoutMs: 10_000,
      activityTimeoutMs: 100,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/No agent activity/)
  }, 10_000)

  it('连续 thinking delta 合并成单行 activity，遇到 tool_use 时 flush', async () => {
    const stream = [
      { type: 'thinking', subtype: 'delta', text: 'I ' },
      { type: 'thinking', subtype: 'delta', text: 'need ' },
      { type: 'thinking', subtype: 'delta', text: 'to ' },
      { type: 'thinking', subtype: 'delta', text: 'understand ' },
      { type: 'thinking', subtype: 'delta', text: 'the ' },
      { type: 'thinking', subtype: 'delta', text: 'request' },
      { type: 'tool_use', name: 'Read', input: { path: '/a' } },
      { type: 'result', result: 'ok' },
    ].map(o => JSON.stringify(o)).join('\n')

    const activities: string[] = []
    const script = `process.stdout.write(${JSON.stringify(stream)} + '\\n'); process.exit(0)`
    await CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: true,
      timeoutMs: 5_000,
      activityTimeoutMs: 5_000,
      onActivity: (a) => activities.push(a),
    })
    const thinkingLines = activities.filter(a => a.includes('🧠'))
    expect(thinkingLines).toHaveLength(1)
    expect(thinkingLines[0]).toContain('I need to understand the request')
    expect(activities.some(a => a.includes('🔧 Tool: Read'))).toBe(true)
  })

  it('thinking → text delta 切换时各自合并 flush', async () => {
    const stream = [
      { type: 'thinking', subtype: 'delta', text: 'plan ' },
      { type: 'thinking', subtype: 'delta', text: 'first' },
      { type: 'assistant', subtype: 'delta', text: 'answer ' },
      { type: 'assistant', subtype: 'delta', text: 'is here' },
      { type: 'result', result: 'answer is here' },
    ].map(o => JSON.stringify(o)).join('\n')

    const activities: string[] = []
    const script = `process.stdout.write(${JSON.stringify(stream)} + '\\n'); process.exit(0)`
    await CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: true,
      timeoutMs: 5_000,
      activityTimeoutMs: 5_000,
      onActivity: (a) => activities.push(a),
    })
    const thinking = activities.filter(a => a.includes('🧠'))
    const writing = activities.filter(a => a.includes('✍️'))
    expect(thinking).toHaveLength(1)
    expect(thinking[0]).toContain('plan first')
    expect(writing).toHaveLength(1)
    expect(writing[0]).toContain('answer is here')
  })

  it('回调：onText / onActivity / onSessionId 被触发', async () => {
    const stream = [
      { type: 'assistant', subtype: 'delta', text: 'hi' },
      { type: 'session_init', session_id: 'sess-xyz' },
      { type: 'tool_use', name: 'Read', input: { path: '/a' } },
      { type: 'result', result: 'hi' },
    ].map(o => JSON.stringify(o)).join('\n')

    const texts: string[] = []
    const activities: string[] = []
    const sessions: string[] = []
    const script = `process.stdout.write(${JSON.stringify(stream)} + '\\n'); process.exit(0)`
    await CliRunner.run({
      binary: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      useStreamJson: true,
      timeoutMs: 5_000,
      activityTimeoutMs: 5_000,
      onText: (t) => texts.push(t),
      onActivity: (a) => activities.push(a),
      onSessionId: (s) => sessions.push(s),
    })
    expect(texts.join('')).toContain('hi')
    expect(activities.some(a => a.includes('🔧 Tool: Read'))).toBe(true)
    expect(sessions).toContain('sess-xyz')
  })
})
