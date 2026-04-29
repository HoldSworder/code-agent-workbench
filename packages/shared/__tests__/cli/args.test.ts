import { describe, expect, it } from 'vitest'
import { buildCliArgs } from '../../src/cli/args'

const CWD = '/repo/foo'
const PROMPT = 'do this'

describe('buildCliArgs - cursor-cli', () => {
  it('write 模式带 yolo/trust/approve-mcps + workspace + 模型 + resume', () => {
    const r = buildCliArgs({ backend: 'cursor-cli', cwd: CWD, mode: 'write', model: 'auto-medium', resumeSessionId: 'sess-1', prompt: PROMPT })
    expect(r.args).toEqual([
      '-p', '--output-format', 'stream-json', '--stream-partial-output',
      '--yolo', '--trust', '--approve-mcps',
      '--workspace', CWD,
      '--model', 'auto-medium',
      '--resume', 'sess-1',
    ])
    expect(r.stdinData).toBe(PROMPT)
    expect(r.useStreamJson).toBe(true)
  })

  it('readonly 模式不带 yolo/trust', () => {
    const r = buildCliArgs({ backend: 'cursor-cli', cwd: CWD, mode: 'readonly', prompt: PROMPT })
    expect(r.args).not.toContain('--yolo')
    expect(r.args).not.toContain('--trust')
    expect(r.args).toContain('--workspace')
  })

  it('planMode 注入 --plan，model=auto 不注入 --model', () => {
    const r = buildCliArgs({ backend: 'cursor-cli', cwd: CWD, mode: 'write', planMode: true, model: 'auto', prompt: PROMPT })
    expect(r.args).toContain('--plan')
    expect(r.args).not.toContain('--model')
  })
})

describe('buildCliArgs - claude-code', () => {
  it('write/readonly 参数相同（无 yolo 概念）', () => {
    const w = buildCliArgs({ backend: 'claude-code', cwd: CWD, mode: 'write', prompt: PROMPT })
    const r = buildCliArgs({ backend: 'claude-code', cwd: CWD, mode: 'readonly', prompt: PROMPT })
    expect(w.args).toEqual(r.args)
    expect(w.args).toEqual(['--print', '-', '--output-format', 'stream-json', '--verbose'])
  })

  it('planMode 注入 permission-mode plan', () => {
    const r = buildCliArgs({ backend: 'claude-code', cwd: CWD, mode: 'write', planMode: true, prompt: PROMPT })
    expect(r.args).toContain('--permission-mode')
    expect(r.args).toContain('plan')
  })

  it('model 与 resume 注入', () => {
    const r = buildCliArgs({ backend: 'claude-code', cwd: CWD, mode: 'write', model: 'sonnet', resumeSessionId: 'abc', prompt: PROMPT })
    expect(r.args.slice(-4)).toEqual(['--model', 'sonnet', '--resume', 'abc'])
  })
})

describe('buildCliArgs - codex', () => {
  it('write 模式 --full-auto，readonly 模式 --approval-mode suggest', () => {
    const w = buildCliArgs({ backend: 'codex', cwd: CWD, mode: 'write', prompt: PROMPT })
    const r = buildCliArgs({ backend: 'codex', cwd: CWD, mode: 'readonly', prompt: PROMPT })
    expect(w.args).toContain('--full-auto')
    expect(r.args).toContain('--approval-mode')
    expect(r.args).toContain('suggest')
  })

  it('useStreamJson 为 false', () => {
    const r = buildCliArgs({ backend: 'codex', cwd: CWD, mode: 'write', prompt: PROMPT })
    expect(r.useStreamJson).toBe(false)
  })

  it('planMode 通过 prompt 前缀注入', () => {
    const r = buildCliArgs({ backend: 'codex', cwd: CWD, mode: 'write', planMode: true, prompt: PROMPT })
    expect(r.stdinData).toContain('[PLAN MODE]')
    expect(r.stdinData).toContain(PROMPT)
  })

  it('cwd 通过 -C 注入', () => {
    const r = buildCliArgs({ backend: 'codex', cwd: CWD, mode: 'write', prompt: PROMPT })
    const idx = r.args.indexOf('-C')
    expect(r.args[idx + 1]).toBe(CWD)
  })
})
