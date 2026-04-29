/**
 * 通用 Prompt 拼接器。
 * 各领域 builder（cli/api/leader/worker/consult/review）围绕它组装自己的章节，
 * 替代分散的 `parts.push(...) → join` 模式。
 */
export class PromptBuilder {
  private parts: string[] = []

  /** 添加一段标题 + 正文的 section（标题用 `## `）。空 body 会被跳过。 */
  section(title: string, body?: string | null): this {
    if (!body) return this
    this.parts.push(`## ${title}\n\n${body}`)
    return this
  }

  /** 添加无序列表。空数组会被跳过。 */
  bullet(items: ReadonlyArray<string>, options?: { title?: string }): this {
    if (!items.length) return this
    const list = items.map(it => `- ${it}`).join('\n')
    if (options?.title) {
      this.parts.push(`## ${options.title}\n\n${list}`)
    }
    else {
      this.parts.push(list)
    }
    return this
  }

  /** 添加代码块。 */
  code(lang: string, content: string): this {
    this.parts.push(`\`\`\`${lang}\n${content}\n\`\`\``)
    return this
  }

  /** 添加水平分隔符。 */
  divider(): this {
    this.parts.push('---')
    return this
  }

  /** 直接添加任意文本段（不带处理）。 */
  text(content?: string | null): this {
    if (!content) return this
    this.parts.push(content)
    return this
  }

  /** 添加引用块（每行加 `> ` 前缀）。 */
  quote(content: string): this {
    if (!content) return this
    const lines = content.split('\n').map(l => `> ${l}`).join('\n')
    this.parts.push(lines)
    return this
  }

  /**
   * 当条件为真时，使用回调注入额外 section。便于链式条件追加。
   */
  when(condition: unknown, fn: (b: PromptBuilder) => void): this {
    if (condition) fn(this)
    return this
  }

  /** 当前 part 数（不含空字符串）。 */
  get length(): number {
    return this.parts.length
  }

  /** 拼接为最终字符串，section 之间默认两个换行。 */
  build(separator = '\n\n'): string {
    return this.parts.join(separator)
  }
}
