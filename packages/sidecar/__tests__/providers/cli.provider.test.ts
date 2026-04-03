import { describe, expect, it } from 'vitest'
import { ExternalCliProvider } from '../../src/providers/cli.provider'

const baseContext = {
  phaseId: 'dev',
  repoPath: '/repo',
  openspecPath: '/repo/openspec',
  branchName: 'main',
  skillContent: 'Do the thing',
}

describe('ExternalCliProvider.buildArgs', () => {
  it('builds claude-code args with optional mcp config', () => {
    const withoutMcp = new ExternalCliProvider({ type: 'claude-code' })
    const argsNoMcp = withoutMcp.buildArgs(baseContext)
    expect(argsNoMcp.slice(0, 3)).toEqual([
      '-p',
      expect.stringContaining('Do the thing'),
      '--output-format',
    ])
    expect(argsNoMcp[3]).toBe('json')
    expect(argsNoMcp).toHaveLength(4)

    const withMcp = new ExternalCliProvider({ type: 'claude-code' })
    const argsMcp = withMcp.buildArgs({
      ...baseContext,
      mcpConfig: '/path/mcp.json',
    })
    expect(argsMcp).toContain('--mcp-config')
    expect(argsMcp).toContain('/path/mcp.json')
  })

  it('builds cursor-cli args', () => {
    const provider = new ExternalCliProvider({ type: 'cursor-cli' })
    const args = provider.buildArgs(baseContext)
    expect(args[0]).toBe('--message')
    expect(args[1]).toContain('Do the thing')
    expect(args[1]).toContain('工作目录')
  })

  it('builds codex args', () => {
    const provider = new ExternalCliProvider({ type: 'codex' })
    const args = provider.buildArgs(baseContext)
    expect(args).toEqual([
      '-p',
      expect.stringContaining('Do the thing'),
      '--output-format',
      'json',
    ])
  })

  it('includes user feedback in prompt for all types', () => {
    const ctx = {
      ...baseContext,
      userMessage: 'Please fix the bug',
    }
    for (const type of ['claude-code', 'cursor-cli', 'codex'] as const) {
      const provider = new ExternalCliProvider({ type })
      const prompt = provider.buildArgs(ctx)[1]
      expect(prompt).toContain('用户反馈')
      expect(prompt).toContain('Please fix the bug')
    }
  })
})
