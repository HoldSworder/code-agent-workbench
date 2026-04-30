import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentRuntimeSettings } from '../../src/providers/factory'
import type { RequirementSource } from '../../src/review/feishu-requirement'

const { llmCallMock, summarizeRepoMock, formatContextMock } = vi.hoisted(() => ({
  llmCallMock: vi.fn(),
  summarizeRepoMock: vi.fn(),
  formatContextMock: vi.fn(),
}))

vi.mock('../../src/review/llm', () => ({ llmCall: llmCallMock }))
vi.mock('../../src/review/code-context', () => ({
  summarizeRepo: summarizeRepoMock,
  formatContextForPrompt: formatContextMock,
}))

import { generateFrontendDesign } from '../../src/review/design-generator'

const RUNTIME: AgentRuntimeSettings = {
  provider: 'cursor-cli',
  apiKey: '',
  model: 'auto',
}

function source(overrides: Partial<RequirementSource> = {}): RequirementSource {
  return {
    workItemUrl: 'https://project.feishu.cn/abc/story/detail/1',
    workItemId: '1',
    projectKey: 'abc',
    workItemType: 'story',
    title: '搜索体验升级',
    sourceType: 'spec_doc',
    sourceFieldLabel: '需求SPEC文档',
    docUrl: 'https://feishu.cn/docx/aaa',
    content: '# 需求 SPEC 正文 ...',
    warnings: [],
    ...overrides,
  }
}

describe('generateFrontendDesign', () => {
  beforeEach(() => {
    llmCallMock.mockReset()
    summarizeRepoMock.mockReset()
    formatContextMock.mockReset()
    summarizeRepoMock.mockResolvedValue({ files: [], imports: [] })
    formatContextMock.mockReturnValue('CONTEXT_SNIPPET')
    llmCallMock.mockResolvedValue('# 前端开发设计 - 搜索体验升级\n\n## Why\n...')
  })

  it('SYSTEM_PROMPT 锁定输出结构与"仅前端"约束，不出现 dev-spec/后端章节关键字', async () => {
    await generateFrontendDesign({
      requirementSource: source(),
      relatedRepos: [{ path: '/repos/web' }],
      runtime: RUNTIME,
    })

    const call = llmCallMock.mock.calls[0][0]
    expect(call.systemPrompt).toContain('前端开发 design.md')
    expect(call.systemPrompt).toContain('Capabilities')
    expect(call.systemPrompt).toContain('待澄清问题')
    expect(call.systemPrompt).toMatch(/严禁编造/)
    // 不应再生产"开发 Spec / 后端方案 / 数据/接口契约（双端）"的旧 dev-spec 章节
    expect(call.systemPrompt).not.toContain('# 开发 Spec')
    expect(call.systemPrompt).not.toContain('后端方案')
  })

  it('userPrompt 含需求来源描述、原文与代码上下文；warnings 命中时单独成段', async () => {
    await generateFrontendDesign({
      requirementSource: source({ warnings: ['SPEC 抓取失败已降级'] }),
      relatedRepos: [{ path: '/repos/web', alias: 'web-app' }],
      runtime: RUNTIME,
    })

    const call = llmCallMock.mock.calls[0][0]
    expect(call.userPrompt).toContain('# 需求标题\n搜索体验升级')
    expect(call.userPrompt).toContain('# 飞书工作项链接\nhttps://project.feishu.cn/abc/story/detail/1')
    expect(call.userPrompt).toContain('需求文档原文（来源：飞书项目「需求SPEC文档」字段：需求SPEC文档（已抓取正文））')
    expect(call.userPrompt).toContain('# 需求 SPEC 正文')
    expect(call.userPrompt).toContain('# 需求采集过程中的警告')
    expect(call.userPrompt).toContain('SPEC 抓取失败已降级')
    expect(call.userPrompt).toContain('# 关联前端代码库上下文')
    expect(call.userPrompt).toContain('## 仓库：web-app')
    expect(call.userPrompt).toContain('CONTEXT_SNIPPET')
  })

  it('已有 design 草稿时按"增量补充"语义注入', async () => {
    await generateFrontendDesign({
      requirementSource: source(),
      relatedRepos: [],
      existingDesign: '# 已有草稿\n\n## Why\n人写的内容',
      runtime: RUNTIME,
    })

    const call = llmCallMock.mock.calls[0][0]
    expect(call.userPrompt).toContain('# 已有 design.md 草稿')
    expect(call.userPrompt).toContain('# 已有草稿')
    expect(call.userPrompt).toContain('增量补充')
  })

  it('title_only 来源时 userPrompt 标注为"仅有标题可用"，不放空白原文', async () => {
    await generateFrontendDesign({
      requirementSource: source({ sourceType: 'title_only', sourceFieldLabel: null, docUrl: null, content: '' }),
      relatedRepos: [],
      runtime: RUNTIME,
    })

    const call = llmCallMock.mock.calls[0][0]
    expect(call.userPrompt).toContain('仅有标题可用')
  })

  it('cwd 与 runtime 透传到 llmCall，便于 CLI provider 走子进程', async () => {
    await generateFrontendDesign({
      requirementSource: source(),
      relatedRepos: [{ path: '/repos/web' }],
      cwd: '/repos/web',
      runtime: RUNTIME,
    })

    const call = llmCallMock.mock.calls[0][0]
    expect(call.cwd).toBe('/repos/web')
    expect(call.runtime).toBe(RUNTIME)
    expect(call.maxTokens).toBe(6000)
  })
})
