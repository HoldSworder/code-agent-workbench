import { describe, expect, it } from 'vitest'
import {
  detectStoryPointFields,
  flattenFieldList,
  type StoryPointFieldRef,
} from '../../src/review/story-point-detector'

const sample = (over: Partial<StoryPointFieldRef> = {}, key = 'field_x', label = 'X'): StoryPointFieldRef => ({
  fieldKey: over.fieldKey ?? key,
  label: over.label ?? label,
})

describe('detectStoryPointFields', () => {
  it('三角色全命中（中文标准命名）', () => {
    const r = detectStoryPointFields([
      sample({}, 'field_a', '前端故事点'),
      sample({}, 'field_b', '后端故事点'),
      sample({}, 'field_c', '测试故事点'),
      sample({}, 'field_x', '其它字段'),
    ])
    expect(r.frontend).toEqual({ fieldKey: 'field_a', label: '前端故事点' })
    expect(r.backend).toEqual({ fieldKey: 'field_b', label: '后端故事点' })
    expect(r.qa).toEqual({ fieldKey: 'field_c', label: '测试故事点' })
    expect(r.allFields).toHaveLength(4)
  })

  it('部分命中（缺测试）', () => {
    const r = detectStoryPointFields([
      sample({}, 'field_a', '前端故事点'),
      sample({}, 'field_b', '后端故事点'),
    ])
    expect(r.frontend?.fieldKey).toBe('field_a')
    expect(r.backend?.fieldKey).toBe('field_b')
    expect(r.qa).toBeNull()
  })

  it('英文同义词 frontend point / backend point / qa point', () => {
    const r = detectStoryPointFields([
      sample({}, 'fk1', 'Frontend Point'),
      sample({}, 'fk2', 'Backend  Story Point'),
      sample({}, 'fk3', 'QA Point'),
    ])
    expect(r.frontend?.fieldKey).toBe('fk1')
    expect(r.backend?.fieldKey).toBe('fk2')
    expect(r.qa?.fieldKey).toBe('fk3')
  })

  it('label 含下划线/空格的同义词归一化', () => {
    const r = detectStoryPointFields([
      sample({}, 'fk1', 'fe_point'),
      sample({}, 'fk2', 'BE Point'),
    ])
    expect(r.frontend?.fieldKey).toBe('fk1')
    expect(r.backend?.fieldKey).toBe('fk2')
  })

  it('字段全空时返回三个 null + allFields 为空', () => {
    const r = detectStoryPointFields([])
    expect(r.frontend).toBeNull()
    expect(r.backend).toBeNull()
    expect(r.qa).toBeNull()
    expect(r.allFields).toEqual([])
  })

  it('同一字段被多角色规则匹配时只归给最先命中的角色', () => {
    // 这条 label 既含「前端」也含「测试」，按角色优先级 frontend 先抢到
    const r = detectStoryPointFields([
      sample({}, 'fk1', '前端测试故事点'),
      sample({}, 'fk2', '后端故事点'),
      sample({}, 'fk3', '测试故事点'),
    ])
    expect(r.frontend?.fieldKey).toBe('fk1')
    expect(r.backend?.fieldKey).toBe('fk2')
    expect(r.qa?.fieldKey).toBe('fk3')
  })

  it('不应误匹配「故事点」单独字段（无角色信号）', () => {
    const r = detectStoryPointFields([
      sample({}, 'fk_only_sp', '故事点'),
      sample({}, 'fk_other', '其它'),
    ])
    expect(r.frontend).toBeNull()
    expect(r.backend).toBeNull()
    expect(r.qa).toBeNull()
  })
})

describe('flattenFieldList', () => {
  it('从 data.fields 容器中提取 field_key + field_alias', () => {
    const json = {
      data: {
        fields: [
          { field_key: 'fk1', field_alias: '前端故事点' },
          { field_key: 'fk2', field_name: '后端故事点' },
        ],
      },
    }
    const r = flattenFieldList(json)
    expect(r).toEqual([
      { fieldKey: 'fk1', label: '前端故事点' },
      { fieldKey: 'fk2', label: '后端故事点' },
    ])
  })

  it('顶层数组直接返回', () => {
    const r = flattenFieldList([{ key: 'fk1', name: 'A' }, { key: 'fk2', label: 'B' }])
    expect(r).toEqual([
      { fieldKey: 'fk1', label: 'A' },
      { fieldKey: 'fk2', label: 'B' },
    ])
  })

  it('多层嵌套时找到第一层 array of object 容器', () => {
    const json = { data: { result: { list: [{ fieldKey: 'fk1', name: 'X' }] } } }
    expect(flattenFieldList(json)).toEqual([{ fieldKey: 'fk1', label: 'X' }])
  })

  it('field_key 缺失的项被丢弃', () => {
    const json = [
      { field_key: 'fk1', name: 'A' },
      { name: 'B' }, // 无 fieldKey，丢弃
      { field_key: '', name: 'C' }, // 空字符串，丢弃
    ]
    expect(flattenFieldList(json)).toEqual([{ fieldKey: 'fk1', label: 'A' }])
  })

  it('label 缺失时回退到 fieldKey', () => {
    expect(flattenFieldList([{ field_key: 'fk1' }])).toEqual([{ fieldKey: 'fk1', label: 'fk1' }])
  })

  it('重复 fieldKey 去重，保留首次', () => {
    const json = [
      { field_key: 'fk1', name: 'A' },
      { field_key: 'fk1', name: 'A2' },
      { field_key: 'fk2', name: 'B' },
    ]
    expect(flattenFieldList(json)).toEqual([
      { fieldKey: 'fk1', label: 'A' },
      { fieldKey: 'fk2', label: 'B' },
    ])
  })
})
