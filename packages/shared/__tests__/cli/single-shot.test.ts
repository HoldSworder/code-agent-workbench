import { describe, expect, it, vi, beforeEach } from 'vitest'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/cli/runner', () => ({
  CliRunner: { run: runMock },
}))

import { runCliSingleShot } from '../../src/cli/single-shot'

describe('runCliSingleShot', () => {
  beforeEach(() => {
    runMock.mockReset()
  })

  it('成功路径：返回 trim 前的文本，并把 system+user prompt 注入 stdin', async () => {
    runMock.mockResolvedValueOnce({
      status: 'success',
      output: 'hello\n',
      tokenUsage: 99,
      exitCode: 0,
    })

    const r = await runCliSingleShot({
      backend: 'cursor-cli',
      systemPrompt: 'be terse',
      userPrompt: 'ping',
      cwd: '/tmp/repo',
    })

    expect(r.text).toBe('hello\n')
    expect(r.tokenUsage).toBe(99)
    expect(runMock).toHaveBeenCalledTimes(1)
    const call = runMock.mock.calls[0][0]
    expect(call.binary).toBe('agent')
    expect(call.cwd).toBe('/tmp/repo')
    // stdin 必须包含 SYSTEM 和 USER 两段标题
    const stdin = String(call.stdinData ?? '')
    expect(stdin).toContain('[SYSTEM]')
    expect(stdin).toContain('be terse')
    expect(stdin).toContain('[USER]')
    expect(stdin).toContain('ping')
  })

  it('binary 缺失时抛出指向「设置」的中文错误，提示 PATH 与 binaryPath', async () => {
    runMock.mockResolvedValueOnce({
      status: 'failed',
      output: '',
      error: 'CLI "agent" not found. Please install it.',
    })

    await expect(runCliSingleShot({
      backend: 'cursor-cli',
      systemPrompt: 's',
      userPrompt: 'u',
    })).rejects.toThrow(/未在 PATH 中找到/)
  })

  it('普通失败把 stderr 透传给上层，不与 ENOENT 文案混淆', async () => {
    runMock.mockResolvedValueOnce({
      status: 'failed',
      output: '',
      error: 'exit code 17',
    })

    await expect(runCliSingleShot({
      backend: 'codex',
      systemPrompt: 's',
      userPrompt: 'u',
    })).rejects.toThrow(/codex 单轮调用失败.*exit code 17/)
  })

  it('binaryPath 优先级高于默认 binary，确保设置中的覆盖生效', async () => {
    runMock.mockResolvedValueOnce({ status: 'success', output: 'x', exitCode: 0 })

    await runCliSingleShot({
      backend: 'claude-code',
      binaryPath: '/custom/path/claude',
      systemPrompt: 's',
      userPrompt: 'u',
    })

    expect(runMock.mock.calls[0][0].binary).toBe('/custom/path/claude')
  })
})
