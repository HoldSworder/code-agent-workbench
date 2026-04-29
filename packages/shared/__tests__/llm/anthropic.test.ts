import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callAnthropic, createLlmClient } from '../../src/llm/anthropic'

const SAVED = { ...process.env }
beforeEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, SAVED)
})
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, SAVED)
})

describe('createLlmClient', () => {
  it('未提供 apiKey 也无环境变量时立刻抛错', () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(() => createLlmClient()).toThrow('ANTHROPIC_API_KEY 未配置')
  })

  it('从环境变量读取 ANTHROPIC_API_KEY 并构造客户端', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake'
    const c = createLlmClient()
    expect(c).toBeDefined()
  })

  it('显式 apiKey 优先于环境变量', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const c = createLlmClient({ apiKey: 'arg-key' })
    expect(c).toBeDefined()
  })
})

describe('callAnthropic', () => {
  it('使用注入 client，正确返回 text 与 usage', async () => {
    const fakeClient = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
            { type: 'image', source: {} },
          ],
          usage: { input_tokens: 3, output_tokens: 5 },
        })),
      },
    } as any

    const r = await callAnthropic({
      systemPrompt: 'sys',
      userPrompt: 'user',
      client: fakeClient,
      model: 'm-1',
      maxTokens: 100,
    })

    expect(r.text).toBe('hello\nworld')
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 5, totalTokens: 8 })
    const callArgs = fakeClient.messages.create.mock.calls[0][0]
    expect(callArgs.model).toBe('m-1')
    expect(callArgs.max_tokens).toBe(100)
    expect(callArgs.system).toBe('sys')
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'user' }])
  })

  it('未传 model 时回退 ANTHROPIC_MODEL 环境变量', async () => {
    process.env.ANTHROPIC_MODEL = 'env-model'
    const fakeClient = {
      messages: {
        create: vi.fn(async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } })),
      },
    } as any
    await callAnthropic({ systemPrompt: '', userPrompt: '', client: fakeClient })
    expect(fakeClient.messages.create.mock.calls[0][0].model).toBe('env-model')
  })
})
