import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lark/cli', () => ({
  runLarkCli: vi.fn(),
}))

import { runLarkCli } from '../../src/lark/cli'
import { getLarkAuthStatus } from '../../src/lark/auth'

const mockRun = runLarkCli as unknown as ReturnType<typeof vi.fn>

interface FakeStatus {
  userOpenId?: string
  userName?: string
  tokenStatus?: string
  expiresAt?: string
  refreshExpiresAt?: string
  appId?: string
}

function status(overrides: FakeStatus = {}): { stdout: string, stderr: string } {
  return {
    stdout: JSON.stringify({
      appId: 'cli_x',
      userOpenId: 'ou_xxx',
      userName: '邱卓然',
      tokenStatus: 'valid',
      expiresAt: '2026-04-29T20:00:00+08:00',
      refreshExpiresAt: '2026-05-05T16:56:56+08:00',
      ...overrides,
    }),
    stderr: '',
  }
}

afterEach(() => {
  mockRun.mockReset()
})

describe('getLarkAuthStatus 自动续期', () => {
  it('valid 直接返回，不触发 +get-user', async () => {
    mockRun.mockResolvedValueOnce(status())

    const r = await getLarkAuthStatus()

    expect(r.loggedIn).toBe(true)
    expect(r.identity?.tokenStatus).toBe('valid')
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(mockRun.mock.calls[0][0]).toEqual(['auth', 'status'])
  })

  it('needs_refresh + refreshExpiresAt 未过期 → 触发 +get-user 后再 status，转为 valid', async () => {
    const future = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    mockRun
      .mockResolvedValueOnce(status({ tokenStatus: 'needs_refresh', refreshExpiresAt: future }))
      .mockResolvedValueOnce({ stdout: '{"ok":true}', stderr: '' })
      .mockResolvedValueOnce(status({ tokenStatus: 'valid' }))

    const r = await getLarkAuthStatus()

    expect(r.loggedIn).toBe(true)
    expect(r.identity?.tokenStatus).toBe('valid')
    expect(mockRun).toHaveBeenCalledTimes(3)
    expect(mockRun.mock.calls[0][0]).toEqual(['auth', 'status'])
    expect(mockRun.mock.calls[1][0]).toEqual(['contact', '+get-user'])
    expect(mockRun.mock.calls[2][0]).toEqual(['auth', 'status'])
  })

  it('needs_refresh + refreshExpiresAt 已过期 → 不触发自动续期，直接报状态异常', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    mockRun.mockResolvedValueOnce(status({ tokenStatus: 'needs_refresh', refreshExpiresAt: past }))

    const r = await getLarkAuthStatus()

    expect(r.loggedIn).toBe(false)
    expect(r.error).toMatch(/needs_refresh/)
    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  it('+get-user 失败时不抛错，第二次 status 仍 needs_refresh 时按异常报出', async () => {
    const future = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    mockRun
      .mockResolvedValueOnce(status({ tokenStatus: 'needs_refresh', refreshExpiresAt: future }))
      .mockRejectedValueOnce(new Error('network down'))

    const r = await getLarkAuthStatus()

    expect(r.loggedIn).toBe(false)
    expect(r.error).toMatch(/needs_refresh/)
    expect(mockRun).toHaveBeenCalledTimes(2)
  })

  it('未登录（缺 userOpenId）不触发自动续期', async () => {
    mockRun.mockResolvedValueOnce({ stdout: '{}', stderr: '' })

    const r = await getLarkAuthStatus()

    expect(r.loggedIn).toBe(false)
    expect(r.error).toMatch(/尚未通过/)
    expect(mockRun).toHaveBeenCalledTimes(1)
  })

  it('lark-cli 未安装时返回友好提示', async () => {
    mockRun.mockRejectedValueOnce(new Error('lark-cli 未安装或不在 PATH 中'))

    const r = await getLarkAuthStatus()

    expect(r.installed).toBe(false)
    expect(r.error).toMatch(/未安装/)
  })
})
