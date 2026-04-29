import { describe, expect, it } from 'vitest'
import { PromptBuilder } from '../../src/util/prompt'

describe('PromptBuilder', () => {
  it('section 拼接为 ## 标题 + 正文', () => {
    const out = new PromptBuilder().section('需求', '修复登录页').build()
    expect(out).toBe('## 需求\n\n修复登录页')
  })

  it('section 空 body 跳过', () => {
    const out = new PromptBuilder().section('A', '内容').section('B', '').section('C', null).build()
    expect(out).toBe('## A\n\n内容')
  })

  it('bullet 渲染为列表，可选带标题', () => {
    const out = new PromptBuilder()
      .bullet(['x', 'y'], { title: '清单' })
      .build()
    expect(out).toBe('## 清单\n\n- x\n- y')
  })

  it('bullet 空数组跳过', () => {
    const out = new PromptBuilder().bullet([], { title: '不该出现' }).build()
    expect(out).toBe('')
  })

  it('divider / code / quote / text 顺序拼接', () => {
    const out = new PromptBuilder()
      .text('intro')
      .divider()
      .code('bash', 'echo hi')
      .quote('warn line1\nline2')
      .build()
    expect(out).toBe('intro\n\n---\n\n```bash\necho hi\n```\n\n> warn line1\n> line2')
  })

  it('when 条件成立时执行 fn', () => {
    const a = new PromptBuilder().when(true, b => b.text('yes')).build()
    const b = new PromptBuilder().when(false, b => b.text('no')).build()
    expect(a).toBe('yes')
    expect(b).toBe('')
  })

  it('build 支持自定义 separator', () => {
    const out = new PromptBuilder().text('A').text('B').build('\n')
    expect(out).toBe('A\nB')
  })

  it('length 反映已添加 part 数量', () => {
    const b = new PromptBuilder()
    expect(b.length).toBe(0)
    b.text('x').text('y')
    expect(b.length).toBe(2)
  })
})
