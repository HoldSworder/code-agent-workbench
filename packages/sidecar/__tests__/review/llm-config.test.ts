import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentRuntimeSettings } from '../../src/providers/factory'

const { promptMock } = vi.hoisted(() => ({
  promptMock: vi.fn(),
}))

vi.mock('@cursor/sdk', () => ({
  Agent: { prompt: promptMock },
  CursorAgentError: class CursorAgentError extends Error {},
}))

import { llmCall } from '../../src/review/llm'

function runtime(cursorApiKey = 'key_test'): AgentRuntimeSettings {
  return { provider: 'cursor-sdk', model: 'composer-2.5', cursorApiKey }
}

describe('review/llm.llmCall (cursor-sdk)', () => {
  beforeEach(() => {
    promptMock.mockReset()
  })

  it('走 Agent.prompt 单轮并透传 apiKey/model/cwd，返回 trim 后的 result', async () => {
    promptMock.mockResolvedValueOnce({ id: 'r1', status: 'finished', result: '  hello world  ' })

    const out = await llmCall({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      runtime: runtime(),
      cwd: '/tmp/repo',
    })

    expect(out).toBe('hello world')
    expect(promptMock).toHaveBeenCalledTimes(1)
    const [prompt, opts] = promptMock.mock.calls[0]
    expect(prompt).toContain('sys')
    expect(prompt).toContain('usr')
    expect(opts.apiKey).toBe('key_test')
    expect(opts.model).toEqual({ id: 'composer-2.5' })
    expect(opts.local.cwd).toBe('/tmp/repo')
    expect(opts.local.settingSources).toEqual([])
  })

  it('缺 cursorApiKey 时直接抛友好提示，不触发 SDK', async () => {
    await expect(llmCall({
      systemPrompt: 's',
      userPrompt: 'u',
      runtime: runtime(''),
    })).rejects.toThrow(/Cursor API Key/)
    expect(promptMock).not.toHaveBeenCalled()
  })

  it('run 非 finished 时抛错', async () => {
    promptMock.mockResolvedValueOnce({ id: 'r2', status: 'error' })
    await expect(llmCall({
      systemPrompt: 's',
      userPrompt: 'u',
      runtime: runtime(),
    })).rejects.toThrow(/执行失败/)
  })
})
