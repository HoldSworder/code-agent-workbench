import { describe, expect, it } from 'vitest'
import { parseLarkDocUrl } from '../../src/lark/url'

describe('parseLarkDocUrl', () => {
  it('解析 wiki url', () => {
    expect(parseLarkDocUrl('https://feishu.cn/wiki/ABC-123')).toEqual({ type: 'wiki', token: 'ABC-123' })
  })

  it('解析 docx url', () => {
    expect(parseLarkDocUrl('https://feishu.cn/docx/Tok_xy12')).toEqual({ type: 'docx', token: 'Tok_xy12' })
  })

  it('解析 doc url', () => {
    expect(parseLarkDocUrl('https://abc.feishu.cn/doc/abcDEF')).toEqual({ type: 'doc', token: 'abcDEF' })
  })

  it('解析 sheets url', () => {
    expect(parseLarkDocUrl('https://feishu.cn/sheets/Shb789')).toEqual({ type: 'sheets', token: 'Shb789' })
  })

  it('不匹配返回 null', () => {
    expect(parseLarkDocUrl('https://example.com/random')).toBeNull()
  })
})
