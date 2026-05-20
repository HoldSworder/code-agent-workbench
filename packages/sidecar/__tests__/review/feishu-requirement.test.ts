import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resolveRequirementDoc } from '../../src/review/feishu-requirement'

/**
 * 旧测试基于 MCP `callTool` 模拟；现在 resolveRequirementDoc 直接吃 meegle workitem get
 * 的输出（顶层 JSON），所以 stub 直接返回业务体即可。
 */
function makeFetchWorkItem(payload: unknown): (args: { projectKey: string, workItemId: string }) => Promise<unknown> {
  return vi.fn().mockResolvedValue(payload)
}

const SAMPLE_URL = 'https://project.feishu.cn/abc123/story/detail/456'

describe('resolveRequirementDoc', () => {
  beforeEach(() => { /* noop */ })

  it('优先级 1：命中「需求SPEC文档」字段 + 飞书文档 URL，触发文档抓取', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        name: '示例需求',
        fields: [
          { field_alias: '需求SPEC文档', field_value: 'https://feishu.cn/docx/spec_token_xxx' },
          { field_alias: '需求文档', field_value: 'https://feishu.cn/docx/req_token_yyy' },
          { field_alias: '描述', field_value: '老旧描述' },
        ],
      },
    })
    const fetchDoc = vi.fn().mockResolvedValue({ content: '# 抓取到的 SPEC 正文' })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('spec_doc')
    expect(r.docUrl).toBe('https://feishu.cn/docx/spec_token_xxx')
    expect(r.content).toBe('# 抓取到的 SPEC 正文')
    expect(r.title).toBe('示例需求')
    expect(r.workItemId).toBe('456')
    expect(r.projectKey).toBe('abc123')
    expect(fetchDoc).toHaveBeenCalledWith('https://feishu.cn/docx/spec_token_xxx')
    expect(fetchDoc).toHaveBeenCalledTimes(1)
  })

  it('优先级 2：SPEC文档缺失，但「需求文档」存在 URL，从需求文档拉取', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        name: '需求 B',
        fields: [
          { field_alias: '需求文档', field_value: 'https://feishu.cn/docx/req_token' },
          { field_alias: '描述', field_value: '描述 B' },
        ],
      },
    })
    const fetchDoc = vi.fn().mockResolvedValue({ content: '# 需求文档正文' })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('requirement_doc')
    expect(r.content).toBe('# 需求文档正文')
  })

  it('优先级 3：仅「描述」字段命中，直接当 markdown 透传，不调 fetchDocContent', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        name: '需求 C',
        fields: [
          { field_alias: '描述', field_value: '## 描述正文\n- 点 1' },
        ],
      },
    })
    const fetchDoc = vi.fn()

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('description')
    expect(r.content).toBe('## 描述正文\n- 点 1')
    expect(fetchDoc).not.toHaveBeenCalled()
  })

  it('SPEC 文档抓取失败时降级到下一优先级（需求文档/描述），并把警告暴露出来', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        name: '需求 D',
        fields: [
          { field_alias: '需求SPEC文档', field_value: 'https://feishu.cn/docx/broken_spec' },
          { field_alias: '描述', field_value: '兜底描述' },
        ],
      },
    })
    const fetchDoc = vi.fn().mockResolvedValue({ content: '', error: 'lark-cli timeout' })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('description')
    expect(r.content).toBe('兜底描述')
    expect(r.warnings.some(w => w.includes('lark-cli timeout'))).toBe(true)
  })

  it('三个候选都无内容时返回 title_only，content 为空字符串', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        name: '需求 E',
        fields: [],
      },
    })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: vi.fn(),
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('title_only')
    expect(r.title).toBe('需求 E')
    expect(r.content).toBe('')
  })

  it('工作项 URL 解析失败抛错，明确指出 URL', async () => {
    await expect(resolveRequirementDoc({
      workItemUrl: 'https://example.com/not-a-feishu-url',
      fetchDocContent: vi.fn(),
      fetchWorkItem: makeFetchWorkItem({}),
    })).rejects.toThrow(/无法解析飞书项目工作项 URL/)
  })

  it('work_item_attribute 容器命中需求 SPEC 文档', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        items: [
          {
            name: '示例需求 attr',
            work_item_attribute: [
              { field_key: 'spec_doc_field', field_alias: '需求SPEC文档', field_value: 'https://feishu.cn/docx/spec_token_attr' },
              { field_alias: '需求文档', field_value: 'inline markdown should be ignored when spec_doc hits' },
            ],
          },
        ],
      },
    })
    const fetchDoc = vi.fn().mockResolvedValue({ content: '# attr SPEC 正文' })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('spec_doc')
    expect(r.docUrl).toBe('https://feishu.cn/docx/spec_token_attr')
    expect(r.content).toBe('# attr SPEC 正文')
    expect(r.sourceFieldLabel).toBe('需求SPEC文档')
    expect(fetchDoc).toHaveBeenCalledWith('https://feishu.cn/docx/spec_token_attr')
  })

  it('work_item_attribute 容器只有描述时回落到 description', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        items: [
          {
            name: '示例需求 attr-desc',
            work_item_attribute: [
              { field_alias: '描述', field_value: '## 需求描述正文 attr\n- 点 1' },
            ],
          },
        ],
      },
    })
    const fetchDoc = vi.fn()

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('description')
    expect(r.content).toBe('## 需求描述正文 attr\n- 点 1')
    expect(r.sourceFieldLabel).toBe('描述')
    expect(fetchDoc).not.toHaveBeenCalled()
  })

  // 回归用例：meegle CLI `workitem get` 实际产出形态
  // - title 在 `work_item_attribute.work_item_name`（attr 是对象，不是数组）
  // - 业务字段在 `work_item_fields: [{ key, name, value }]`
  it('meegle CLI 形态：title 从 work_item_attribute 读取；work_item_fields 数组用 key/name/value', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      pagination: { has_more: false, page_size: 100, total: 33 },
      work_item_attribute: {
        work_item_id: 6995189342,
        work_item_name: '客服接入coze工作流带入历史会话信息',
        work_item_status: { state_key: 'developing' },
      },
      work_item_current_node: { state_key: 'developing' },
      work_item_fields: [
        { key: 'description', name: '描述', value: '创建coze对话接入历史的对话信息' },
        { key: 'wiki', name: '需求文档', value: 'https://guanghe.feishu.cn/docx/req_xxx' },
        { key: 'field_f0dace', name: '需求SPEC文档', value: 'https://guanghe.feishu.cn/docx/spec_xxx' },
        { key: 'priority', name: '优先级', value: 'high' },
      ],
    })
    const fetchDoc = vi.fn().mockResolvedValue({ content: '# SPEC 正文 from doc' })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: fetchDoc,
      fetchWorkItem,
    })

    expect(r.title).toBe('客服接入coze工作流带入历史会话信息')
    expect(r.sourceType).toBe('spec_doc')
    expect(r.docUrl).toBe('https://guanghe.feishu.cn/docx/spec_xxx')
    expect(r.content).toBe('# SPEC 正文 from doc')

    // 三件套都被原样保留供 UI 卡片展示
    expect(r.feishuFields.description).toBe('创建coze对话接入历史的对话信息')
    expect(r.feishuFields.requirementDocUrl).toBe('https://guanghe.feishu.cn/docx/req_xxx')
    expect(r.feishuFields.specDocUrl).toBe('https://guanghe.feishu.cn/docx/spec_xxx')
  })

  it('work_item_current_node 等元字段不被误当作业务字段（不出现在 title_only 的 warnings 里）', async () => {
    const fetchWorkItem = makeFetchWorkItem({
      data: {
        items: [
          {
            name: '示例需求 meta-only',
            work_item_attribute: [],
            work_item_current_node: { state_key: 'developing' },
            workflow_infos: { foo: 'bar' },
            sub_tasks: [],
            related_work_items: [],
          },
        ],
      },
    })

    const r = await resolveRequirementDoc({
      workItemUrl: SAMPLE_URL,
      fetchDocContent: vi.fn(),
      fetchWorkItem,
    })

    expect(r.sourceType).toBe('title_only')
    expect(r.title).toBe('示例需求 meta-only')
    const warningsBlob = r.warnings.join('\n')
    expect(warningsBlob).not.toContain('work_item_current_node')
    expect(warningsBlob).not.toContain('workflow_infos')
    expect(warningsBlob).not.toContain('sub_tasks')
    expect(warningsBlob).not.toContain('related_work_items')
  })
})
