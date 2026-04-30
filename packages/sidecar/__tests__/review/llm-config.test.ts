import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentRuntimeSettings } from '../../src/providers/factory'

const { callAnthropicMock, runCliSingleShotMock } = vi.hoisted(() => ({
  callAnthropicMock: vi.fn(),
  runCliSingleShotMock: vi.fn(),
}))

vi.mock('@code-agent/shared/llm', () => ({
  callAnthropic: callAnthropicMock,
  createLlmClient: vi.fn(),
}))

vi.mock('@code-agent/shared/cli', () => ({
  runCliSingleShot: runCliSingleShotMock,
}))

import { llmCall } from '../../src/review/llm'

function cliRuntime(provider: 'cursor-cli' | 'claude-code' | 'codex'): AgentRuntimeSettings {
  return {
    provider,
    model: 'auto',
    binaryPath: '/usr/local/bin/agent',
    apiKey: '',
    proxyUrl: 'socks5://127.0.0.1:7890',
  }
}

function apiRuntime(apiKey = ''): AgentRuntimeSettings {
  return {
    provider: 'custom-api',
    model: 'claude-sonnet-4-20250514',
    apiKey,
    baseUrl: 'https://anthropic.example.com',
  }
}

describe('review/llm.llmCall', () => {
  beforeEach(() => {
    callAnthropicMock.mockReset()
    runCliSingleShotMock.mockReset()
  })

  it('CLI provider 路径走 runCliSingleShot 并透传 binaryPath/proxy/cwd', async () => {
    runCliSingleShotMock.mockResolvedValueOnce({ text: '  hello world  ', exitCode: 0 })

    const out = await llmCall({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      runtime: cliRuntime('cursor-cli'),
      cwd: '/tmp/repo',
    })

    expect(out).toBe('hello world')
    expect(runCliSingleShotMock).toHaveBeenCalledTimes(1)
    expect(callAnthropicMock).not.toHaveBeenCalled()
    const call = runCliSingleShotMock.mock.calls[0][0]
    expect(call.backend).toBe('cursor-cli')
    expect(call.binaryPath).toBe('/usr/local/bin/agent')
    expect(call.proxyUrl).toBe('socks5://127.0.0.1:7890')
    expect(call.cwd).toBe('/tmp/repo')
    expect(call.systemPrompt).toBe('sys')
    expect(call.userPrompt).toBe('usr')
  })

  it('custom-api 路径走 callAnthropic 并透传 apiKey/baseUrl/model/maxTokens', async () => {
    callAnthropicMock.mockResolvedValueOnce({
      text: '  ok  ',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    })

    const out = await llmCall({
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 1024,
      runtime: apiRuntime('sk-test'),
    })

    expect(out).toBe('ok')
    expect(callAnthropicMock).toHaveBeenCalledTimes(1)
    expect(runCliSingleShotMock).not.toHaveBeenCalled()
    expect(callAnthropicMock).toHaveBeenCalledWith({
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 1024,
      apiKey: 'sk-test',
      baseUrl: 'https://anthropic.example.com',
      model: 'claude-sonnet-4-20250514',
    })
  })

  it('custom-api 缺 apiKey 时直接抛友好提示，不再触发底层 SDK', async () => {
    await expect(llmCall({
      systemPrompt: 's',
      userPrompt: 'u',
      runtime: apiRuntime(''),
    })).rejects.toThrow(/agent\.apiKey/)
    expect(callAnthropicMock).not.toHaveBeenCalled()
  })
})
