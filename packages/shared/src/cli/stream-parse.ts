/**
 * Agent CLI stdout 解析工具集合。
 *
 * 各 backend 的 stream-json 协议略有差异（cursor-cli delta、claude-code stream_event、
 * codex result、Anthropic content_block_delta），这里把它们归一化为统一的：
 * - 文本片段（用于增量回显）
 * - 活动条目（用于 UI activity 日志）
 * - sessionId / tokenUsage 等元信息
 */

/** 移除一行末尾 \r 与 stdout/stderr 前缀，返回可解析的 JSON 字符串。 */
export function normalizeLine(raw: string): string {
  const trimmed = raw.replace(/\r/g, '').trim()
  if (!trimmed) return ''
  const prefixed = trimmed.match(/^(?:stdout|stderr)\s*[:=]?\s*([\[{].*)$/i)
  return prefixed ? prefixed[1].trim() : trimmed
}

/** 移除 `<think>` / `<thinking>` 标签并归并多行。 */
export function stripThinkTags(text: string): string {
  return text.replace(/<\/?think(?:ing)?>/gi, '').replace(/\n{3,}/g, '\n\n')
}

function activityTimestamp(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function extractToolName(evt: Record<string, any>): string {
  return evt.tool ?? evt.tool_name ?? evt.name ?? 'unknown'
}

function extractToolInput(evt: Record<string, any>): string {
  const input = evt.input ?? evt.tool_input ?? evt.params ?? {}
  if (typeof input === 'string') return input.slice(0, 120)
  if (input.command) return input.command.slice(0, 120)
  if (input.path) return input.path
  if (input.pattern) return `pattern: ${input.pattern}`
  if (input.query) return `query: ${input.query.slice(0, 80)}`
  if (input.glob_pattern) return input.glob_pattern
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  return keys.slice(0, 3).join(', ')
}

/**
 * 抽取一行人类可读的活动条目；返回 null 表示该事件不需要打 activity 日志。
 */
export function extractActivityEntry(line: string): string | null {
  try {
    const evt = JSON.parse(line) as Record<string, any>
    const ts = activityTimestamp()

    if (evt.type === 'thinking' && evt.subtype === 'delta' && typeof evt.text === 'string') {
      const snippet = evt.text.replace(/\n/g, ' ').trim().slice(-60)
      if (snippet) return `[${ts}] 🧠 ${snippet}`
      return null
    }

    if (evt.type === 'assistant' && evt.subtype === 'delta' && typeof evt.text === 'string') {
      const snippet = stripThinkTags(evt.text).replace(/\n/g, ' ').slice(0, 80)
      if (snippet.trim()) return `[${ts}] ✍️ ${snippet}`
      return null
    }

    if (evt.type === 'assistant' && !evt.subtype) {
      const blocks = evt.message?.content ?? evt.content
      if (!Array.isArray(blocks) || blocks.length === 0) return null
      const lastBlock = blocks[blocks.length - 1]
      if (lastBlock.type === 'tool_use') {
        const name = lastBlock.name ?? 'unknown'
        const input = extractToolInput(lastBlock)
        return `[${ts}] 🔧 Tool: ${name}${input ? ` → ${input}` : ''}`
      }
      if (lastBlock.type === 'tool_result') {
        const status = lastBlock.is_error ? '❌' : '✅'
        const len = typeof lastBlock.content === 'string' ? lastBlock.content.length : 0
        return `[${ts}] ${status} Tool result${len ? ` (${len} chars)` : ''}`
      }
      if (lastBlock.type === 'text') {
        const snippet = (lastBlock.text ?? '').replace(/\n/g, ' ').trim().slice(-60)
        if (snippet) return `[${ts}] ✍️ ${snippet}`
      }
      return null
    }

    if (evt.type === 'user')
      return `[${ts}] 📨 User message received`

    if (evt.type === 'system') {
      if (evt.subtype === 'init')
        return `[${ts}] ⚙️ Init | Model: ${evt.model ?? 'unknown'}`
      return `[${ts}] ⚙️ System: ${evt.subtype ?? evt.message ?? ''}`
    }

    if (evt.type === 'text' && typeof evt.text === 'string') {
      const snippet = stripThinkTags(evt.text).replace(/\n/g, ' ').slice(0, 80)
      if (snippet.trim()) return `[${ts}] ✍️ ${snippet}`
      return null
    }

    if (evt.type === 'tool_use' || evt.subtype === 'tool_use') {
      const tool = extractToolName(evt)
      const input = extractToolInput(evt)
      return `[${ts}] 🔧 Tool: ${tool}${input ? ` → ${input}` : ''}`
    }

    if (evt.type === 'assistant' && evt.subtype === 'tool_use_delta')
      return null

    if (evt.type === 'tool_result' || evt.subtype === 'tool_result') {
      const len = typeof evt.output === 'string' ? evt.output.length : (evt.content?.length ?? 0)
      const status = evt.is_error ? '❌' : '✅'
      return `[${ts}] ${status} Tool result${len ? ` (${len} chars)` : ''}`
    }

    if (evt.type === 'stream_event') {
      const inner = evt.event
      if (!inner) return null
      const delta = inner.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const snippet = delta.text.replace(/\n/g, ' ').slice(0, 80)
        if (snippet.trim()) return `[${ts}] ✍️ ${snippet}`
        return null
      }
      if (delta?.type === 'input_json_delta') return null
      if (inner.type === 'content_block_start') {
        const block = inner.content_block
        if (block?.type === 'tool_use')
          return `[${ts}] 🔧 Tool: ${block.name ?? 'unknown'}`
        return null
      }
      if (inner.type === 'content_block_stop' || inner.type === 'message_start'
        || inner.type === 'message_stop' || inner.type === 'message_delta')
        return null
    }

    if (evt.type === 'content_block_delta') {
      if (evt.delta?.type === 'text_delta') {
        const snippet = (evt.delta.text ?? '').replace(/\n/g, ' ').slice(0, 80)
        if (snippet.trim()) return `[${ts}] ✍️ ${snippet}`
      }
      return null
    }

    if (evt.type === 'result')
      return `[${ts}] 🏁 Agent completed`

    return null
  }
  catch { return null }
}

/**
 * 从一行归一化后的 JSON 中提取增量文本和"是否完成"标记。
 */
export function extractStreamText(line: string): { text: string, isComplete: boolean } {
  const EMPTY = { text: '', isComplete: false }
  try {
    const evt = JSON.parse(line) as Record<string, any>

    if (evt.type === 'assistant' && evt.subtype === 'delta' && typeof evt.text === 'string')
      return { text: stripThinkTags(evt.text), isComplete: false }

    if (evt.type === 'text' && typeof evt.text === 'string')
      return { text: stripThinkTags(evt.text), isComplete: false }

    if (evt.type === 'stream_event') {
      const delta = evt.event?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string')
        return { text: delta.text, isComplete: false }
    }

    if (evt.type === 'content_block_delta' && evt.delta?.text)
      return { text: evt.delta.text, isComplete: false }

    if (evt.type === 'assistant' && !evt.subtype) {
      const blocks = evt.message?.content ?? evt.content
      let fullText = ''
      if (Array.isArray(blocks))
        fullText = blocks.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
      else if (typeof blocks === 'string')
        fullText = blocks
      fullText = stripThinkTags(fullText)
      if (fullText)
        return { text: fullText, isComplete: true }
    }

    if (evt.type === 'result' && typeof evt.result === 'string')
      return { text: stripThinkTags(evt.result), isComplete: true }
  }
  catch { /* not valid JSON */ }
  return EMPTY
}

/**
 * 从已收集到的 stdout 中提取最终输出文本（兜底用于 useStreamJson 时未拼到 assistantText）。
 */
export function parseStreamResult(stdout: string): string {
  const lines = stdout.split('\n')
  const deltas: string[] = []
  let lastCompleteAssistant = ''

  for (const raw of lines) {
    const normalized = normalizeLine(raw)
    if (!normalized) continue
    try {
      const evt = JSON.parse(normalized) as Record<string, any>
      if (evt.type === 'result') {
        const r = evt.result ?? evt.text
        if (typeof r === 'string') return stripThinkTags(r)
      }
      if (evt.type === 'assistant' && !evt.subtype) {
        const blocks = evt.message?.content ?? evt.content
        if (Array.isArray(blocks))
          lastCompleteAssistant = stripThinkTags(blocks.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(''))
        else if (typeof blocks === 'string')
          lastCompleteAssistant = stripThinkTags(blocks)
        continue
      }
    }
    catch { /* skip */ }
    const { text } = extractStreamText(normalized)
    if (text) deltas.push(text)
  }

  if (deltas.length > 0) return deltas.join('')
  if (lastCompleteAssistant) return lastCompleteAssistant
  return stdout
}

/**
 * 从 stdout 末尾找 `result` 事件，提取 token usage。
 */
export function extractTokenUsage(stdout: string): number | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = normalizeLine(lines[i])
    if (!line) continue
    try {
      const evt = JSON.parse(line) as Record<string, any>
      if (evt.type === 'result')
        return evt.total_tokens ?? evt.usage?.total_tokens ?? evt.num_tokens
    }
    catch { /* skip */ }
  }
  return undefined
}

/** 从一行 JSON 中提取 session_id（多种字段名兜底）。 */
export function extractSessionId(line: string): string | null {
  try {
    const evt = JSON.parse(line) as Record<string, any>
    const id = evt.session_id ?? evt.sessionId ?? evt.sessionID ?? evt.message?.session_id
    if (typeof id === 'string' && id) return id
  }
  catch { /* ignore */ }
  return null
}

/** codex 非 stream-json 模式下的 JSON 输出解析。 */
export function parseJsonOutput(stdout: string): { text: string, tokenUsage?: number } {
  try {
    const json = JSON.parse(stdout) as Record<string, any>
    return { text: json.result ?? json.output ?? stdout, tokenUsage: json.usage?.total_tokens }
  }
  catch {
    return { text: stdout }
  }
}
