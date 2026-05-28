import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PhaseContext } from '../../src/providers/types'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('@code-agent/shared/cli', async () => {
  const actual = await vi.importActual<typeof import('@code-agent/shared/cli')>('@code-agent/shared/cli')
  return {
    ...actual,
    CliRunner: { run: runMock },
    resolveBinary: () => '/usr/bin/true',
    buildAgentEnv: () => ({}),
    buildCliArgs: () => ({ args: [], stdinData: null, useStreamJson: false }),
  }
})

import { ExternalCliProvider } from '../../src/providers/cli.provider'

const baseContext: PhaseContext = {
  stageId: 'planning',
  stageName: '任务规划',
  phaseId: 'spec-create',
  repoPath: '/tmp/repo',
  openspecPath: '/tmp/repo/openspec',
  branchName: 'feat/test',
  skillContent: '',
}

beforeEach(() => {
  runMock.mockReset()
})

describe('ExternalCliProvider — signal overrides exit code', () => {
  it('treats failed-exit + <<PHASE_COMPLETE>> as success and surfaces error as warning', async () => {
    runMock.mockResolvedValue({
      status: 'failed',
      output: 'I did the work successfully. <<PHASE_COMPLETE>>',
      error: 'Exit code: 1',
      exitCode: 1,
    })

    const provider = new ExternalCliProvider({ type: 'cursor-cli' })
    const result = await provider.run(baseContext)

    expect(result.status).toBe('success')
    expect(result.output).toContain('<<PHASE_COMPLETE>>')
    expect(result.error).toBe('Exit code: 1')
  })

  it('treats failed-exit + <<PENDING_INPUT>> as success', async () => {
    runMock.mockResolvedValue({
      status: 'failed',
      output: 'I need your input. <<PENDING_INPUT>>',
      error: 'Exit code: 137',
      exitCode: 137,
    })

    const provider = new ExternalCliProvider({ type: 'cursor-cli' })
    const result = await provider.run(baseContext)

    expect(result.status).toBe('success')
    expect(result.output).toContain('<<PENDING_INPUT>>')
    expect(result.error).toBe('Exit code: 137')
  })

  it('keeps failed status when no signal is present', async () => {
    runMock.mockResolvedValue({
      status: 'failed',
      output: 'something half-baked',
      error: 'Exit code: 1',
      exitCode: 1,
    })

    const provider = new ExternalCliProvider({ type: 'cursor-cli' })
    const result = await provider.run(baseContext)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Exit code: 1')
  })

  it('keeps success unchanged with no warning when exit code is 0', async () => {
    runMock.mockResolvedValue({
      status: 'success',
      output: 'all good <<PHASE_COMPLETE>>',
      tokenUsage: 123,
      exitCode: 0,
    })

    const provider = new ExternalCliProvider({ type: 'cursor-cli' })
    const result = await provider.run(baseContext)

    expect(result.status).toBe('success')
    expect(result.error).toBeUndefined()
    expect(result.tokenUsage).toBe(123)
  })
})
