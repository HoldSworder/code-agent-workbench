import { describe, expect, it, vi } from 'vitest'
import { generateBranchSlug, normalizeSlug } from '../../src/llm/slug'

function fakeClient(text: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    },
  } as any
}

describe('normalizeSlug', () => {
  it('保留标准 kebab-case', () => {
    expect(normalizeSlug('add-user-login')).toBe('add-user-login')
  })

  it('清洗引号、前后空白', () => {
    expect(normalizeSlug('  "Add User Login"  ')).toBe('add-user-login')
  })

  it('剥离 feature/ 前缀', () => {
    expect(normalizeSlug('feature/refactor-auth')).toBe('refactor-auth')
    expect(normalizeSlug('feature-refactor-auth')).toBe('refactor-auth')
  })

  it('下划线/多余符号归一化', () => {
    expect(normalizeSlug('add_user__login!')).toBe('add-user-login')
  })

  it('只取第一行', () => {
    expect(normalizeSlug('add-user-login\nor add-login')).toBe('add-user-login')
  })

  it('完全无合法字符时抛错', () => {
    expect(() => normalizeSlug('!!!')).toThrow(/无法归一化/)
  })

  it('过长 slug 截断到 60 字符内并按 hyphen 边界对齐', () => {
    const long = Array.from({ length: 20 }, () => 'segment').join('-')
    const out = normalizeSlug(long)
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out.endsWith('-')).toBe(false)
  })
})

describe('generateBranchSlug', () => {
  it('正常流程：调 LLM 并清洗输出', async () => {
    const client = fakeClient('"Add-User-Login"')
    const slug = await generateBranchSlug('新增用户登录', { client })
    expect(slug).toBe('add-user-login')
    expect(client.messages.create).toHaveBeenCalledOnce()
    const args = client.messages.create.mock.calls[0][0]
    expect(args.max_tokens).toBe(64)
    expect(args.system).toMatch(/kebab-case/)
  })

  it('空 title 抛错', async () => {
    await expect(generateBranchSlug('  ', { client: fakeClient('x') })).rejects.toThrow(/title 为空/)
  })

  it('超时抛错', async () => {
    const slowClient = {
      messages: {
        create: vi.fn(
          () => new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }], usage: { input_tokens: 0, output_tokens: 0 } }), 200)),
        ),
      },
    } as any
    await expect(generateBranchSlug('需求', { client: slowClient, timeoutMs: 20 })).rejects.toThrow(/超时/)
  })
})
