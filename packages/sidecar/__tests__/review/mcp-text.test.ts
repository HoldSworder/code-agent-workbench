import { describe, expect, it } from 'vitest'
import { extractMcpText, normalizeViewItems, parseMarkdownTableItems, parseMcpJson } from '../../src/review/mcp-text'

describe('extractMcpText', () => {
  it('returns null for null/empty/non-array', () => {
    expect(extractMcpText(null)).toBeNull()
    expect(extractMcpText({})).toBeNull()
    expect(extractMcpText({ content: 'x' })).toBeNull()
  })

  it('returns null when isError', () => {
    expect(extractMcpText({ content: [{ type: 'text', text: 'oops' }], isError: true })).toBeNull()
  })

  it('skips log_id prefixed text and picks the next text content', () => {
    const result = {
      content: [
        { type: 'text', text: 'log_id: abc-123' },
        { type: 'text', text: '{"list":[]}' },
      ],
    }
    expect(extractMcpText(result)).toBe('{"list":[]}')
  })

  it('returns first text content when no log prefix', () => {
    expect(extractMcpText({ content: [{ type: 'text', text: 'hello' }] })).toBe('hello')
  })
})

describe('parseMcpJson', () => {
  it('parses valid JSON text', () => {
    const out = parseMcpJson<{ list: number[] }>({ content: [{ type: 'text', text: '{"list":[1,2]}' }] })
    expect(out).toEqual({ list: [1, 2] })
  })

  it('returns null on invalid JSON', () => {
    expect(parseMcpJson({ content: [{ type: 'text', text: 'not json' }] })).toBeNull()
  })
})

describe('normalizeViewItems', () => {
  const ctx = { projectKey: 'pk_demo', workItemType: 'story' }

  it('handles empty / unknown shapes gracefully', () => {
    expect(normalizeViewItems(null, ctx)).toEqual([])
    expect(normalizeViewItems({}, ctx)).toEqual([])
    expect(normalizeViewItems({ list: 'not array' }, ctx)).toEqual([])
  })

  it('extracts id/title/status/owners and builds source url', () => {
    const json = {
      list: [
        {
          id: 1234567890,
          name: '需求 A',
          current_state: { label: '开发中' },
          role_owners: [
            { owners: [{ name: '张三' }, { name: '张三' }] },
            { owners: [{ name: '李四' }] },
          ],
        },
        {
          work_item_id: '999',
          name: '需求 B',
          workflow_infos: [{ field_value: { label: '待评审' } }],
          current_owner: { name: '王五' },
        },
      ],
    }
    const items = normalizeViewItems(json, ctx)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: '1234567890',
      title: '需求 A',
      statusLabel: '开发中',
      ownerNames: ['张三', '李四'],
      sourceUrl: 'https://project.feishu.cn/pk_demo/story/detail/1234567890',
    })
    expect(items[1]).toMatchObject({
      id: '999',
      statusLabel: '待评审',
      ownerNames: ['王五'],
    })
  })

  it('skips items without id', () => {
    const json = { list: [{ name: '没有 id' }, { id: 1, name: '有 id' }] }
    expect(normalizeViewItems(json, ctx)).toHaveLength(1)
  })

  it('falls back to data.list and items[]', () => {
    expect(normalizeViewItems({ data: { list: [{ id: 1, name: 'a' }] } }, ctx)).toHaveLength(1)
    expect(normalizeViewItems({ items: [{ id: 2, name: 'b' }] }, ctx)).toHaveLength(1)
  })

  it('accepts plain string current_state / current_owner', () => {
    const json = { list: [{ id: 1, name: 'x', current_state: '已发布', current_owner: '老六' }] }
    const items = normalizeViewItems(json, ctx)
    expect(items[0].statusLabel).toBe('已发布')
    expect(items[0].ownerNames).toEqual(['老六'])
  })
})

describe('parseMarkdownTableItems', () => {
  const ctx = { projectKey: 'wuhan', workItemType: 'story' }

  it('returns empty for null/empty/non-table text', () => {
    expect(parseMarkdownTableItems(null, ctx)).toEqual([])
    expect(parseMarkdownTableItems('', ctx)).toEqual([])
    expect(parseMarkdownTableItems('just plain text\nno table here', ctx)).toEqual([])
  })

  it('parses real Feishu MCP markdown response (name + work item id)', () => {
    const raw = [
      '———共查询到 50 条结果，总计 1 页。以下是第 1 页明细——',
      '# 视图工作项列表',
      '| 名称 | 工作项 ID |',
      '| --- | --- |',
      '| 帮助中心咨询客服弹窗替换 | 6948554224 |',
      '| 规则引擎触发明细优化 | 6952650257 |',
      '| 镜像画像 | 6968276006 |',
    ].join('\n')
    const items = parseMarkdownTableItems(raw, ctx)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      id: '6948554224',
      title: '帮助中心咨询客服弹窗替换',
      statusLabel: null,
      ownerNames: [],
      sourceUrl: 'https://project.feishu.cn/wuhan/story/detail/6948554224',
    })
    expect(items[2].id).toBe('6968276006')
  })

  it('extracts status and owners when columns present', () => {
    const raw = [
      '| 工作项id | 标题 | 状态 | 当前负责人 |',
      '| --- | --- | --- | --- |',
      '| 123 | 需求 A | 进行中 | 张三、李四 |',
      '| 456 | 需求 B | 已发布 | 王五 |',
    ].join('\n')
    const items = parseMarkdownTableItems(raw, ctx)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: '123',
      title: '需求 A',
      statusLabel: '进行中',
      ownerNames: ['张三', '李四'],
    })
    expect(items[1].statusLabel).toBe('已发布')
    expect(items[1].ownerNames).toEqual(['王五'])
  })

  it('skips trailing rows whose id is not numeric (truncated text)', () => {
    const raw = [
      '| 名称 | 工作项 ID |',
      '| --- | --- |',
      '| 正常 | 999 |',
      '| 截断行 | 8',
    ].join('\n')
    const items = parseMarkdownTableItems(raw, ctx)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('999')
  })

  it('returns empty when header has no recognizable id column', () => {
    const raw = [
      '| 颜色 | 描述 |',
      '| --- | --- |',
      '| 红 | abc |',
    ].join('\n')
    expect(parseMarkdownTableItems(raw, ctx)).toEqual([])
  })
})
