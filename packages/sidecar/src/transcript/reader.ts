import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── Data types (aligned with claude-replay Turn structure) ──

export interface ToolCall {
  tool_use_id: string
  name: string
  input: Record<string, any>
  result: string | null
  resultTimestamp: string | null
  is_error: boolean
}

export interface AssistantBlock {
  kind: 'text' | 'thinking' | 'tool_use'
  text: string
  tool_call: ToolCall | null
  timestamp: string | null
}

export interface Turn {
  index: number
  user_text: string
  blocks: AssistantBlock[]
  timestamp: string
}

export interface TranscriptData {
  sessionId: string
  format: string
  turns: Turn[]
  filePath: string
}

// ── Session file resolution (mirrors claude-replay resolve-session.mjs) ──

interface SessionMatch {
  path: string
  project: string
  group: string
}

function resolveSessionFile(sessionId: string): SessionMatch | null {
  const home = homedir()
  const target = sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`

  // Claude Code: ~/.claude/projects/<project>/<id>.jsonl
  const claudeBase = join(home, '.claude', 'projects')
  if (existsSync(claudeBase)) {
    try {
      for (const proj of readdirSync(claudeBase)) {
        const projPath = join(claudeBase, proj)
        try { if (!statSync(projPath).isDirectory()) continue } catch { continue }
        const filePath = join(projPath, target)
        if (existsSync(filePath))
          return { path: filePath, project: proj, group: 'claude-code' }
      }
    }
    catch { /* ignore */ }
  }

  // Cursor: ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl
  //    or:  ~/.cursor/projects/<project>/agent-transcripts/<id>/transcript.jsonl
  const cursorBase = join(home, '.cursor', 'projects')
  if (existsSync(cursorBase)) {
    try {
      for (const proj of readdirSync(cursorBase)) {
        const transcriptsDir = join(cursorBase, proj, 'agent-transcripts')
        let filePath = join(transcriptsDir, sessionId, 'transcript.jsonl')
        if (existsSync(filePath))
          return { path: filePath, project: proj, group: 'cursor' }
        filePath = join(transcriptsDir, sessionId, target)
        if (existsSync(filePath))
          return { path: filePath, project: proj, group: 'cursor' }
      }
    }
    catch { /* ignore */ }
  }

  // Codex: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
  const codexBase = join(home, '.codex', 'sessions')
  if (existsSync(codexBase)) {
    try {
      for (const year of readdirSync(codexBase)) {
        const yearPath = join(codexBase, year)
        try { if (!statSync(yearPath).isDirectory()) continue } catch { continue }
        for (const month of readdirSync(yearPath)) {
          const monthPath = join(yearPath, month)
          try { if (!statSync(monthPath).isDirectory()) continue } catch { continue }
          for (const day of readdirSync(monthPath)) {
            const dayPath = join(monthPath, day)
            try { if (!statSync(dayPath).isDirectory()) continue } catch { continue }
            for (const f of readdirSync(dayPath)) {
              if (!f.endsWith('.jsonl')) continue
              if (f === target) return { path: join(dayPath, f), project: `${year}-${month}-${day}`, group: 'codex' }
              const stem = f.replace(/\.jsonl$/, '')
              const uuidMatch = stem.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/)
              if (uuidMatch && uuidMatch[1].includes(sessionId))
                return { path: join(dayPath, f), project: `${year}-${month}-${day}`, group: 'codex' }
            }
          }
        }
      }
    }
    catch { /* ignore */ }
  }

  return null
}

// ── Format detection ──

function detectFormat(firstObj: Record<string, any>): string {
  if (firstObj.type === 'session_meta' || firstObj.type === 'thread.started')
    return 'codex'
  if (firstObj.type === 'item.completed' && firstObj.item)
    return 'codex'
  if (firstObj.type === 'user' || firstObj.type === 'assistant')
    return 'claude-code'
  if (!firstObj.type && (firstObj.role === 'user' || firstObj.role === 'assistant'))
    return 'cursor'
  return 'unknown'
}

function detectFormatFromLines(lines: Record<string, any>[]): string {
  for (const obj of lines) {
    const fmt = detectFormat(obj)
    if (fmt !== 'unknown') return fmt
  }
  return 'unknown'
}

// ── Shared parsing utilities (ported from claude-replay shared.mjs) ──

function cleanSystemTags(text: string): string {
  text = text.replace(/<task-notification>\s*<task-id>[^<]*<\/task-id>\s*<output-file>[^<]*<\/output-file>\s*<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>\s*<\/task-notification>/g,
    (_, _status, summary) => `[bg-task: ${summary}]`)
  text = text.replace(/<user_query>([\s\S]*?)<\/user_query>\s*/g, (_, inner) => (inner as string).trim())
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
  text = text.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>\s*/g, '')
  text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/g, '')
  text = text.replace(/<command-name>([\s\S]*?)<\/command-name>\s*/g, (_, name) => (name as string).trim() + '\n')
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>\s*/g, '')
  text = text.replace(/<command-args>\s*<\/command-args>\s*/g, '')
  text = text.replace(/<command-args>([\s\S]*?)<\/command-args>\s*/g, (_, args) => {
    const trimmed = (args as string).trim()
    return trimmed ? trimmed + '\n' : ''
  })
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>\s*/g, '')
  return text.trim()
}

function extractText(content: any): string {
  if (typeof content === 'string') return cleanSystemTags(content)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text ?? '')
  }
  return cleanSystemTags(parts.join('\n'))
}

function isToolResultOnly(content: any): boolean {
  if (typeof content === 'string') return false
  if (!Array.isArray(content)) return false
  return content.every((b: any) => b.type === 'tool_result')
}

function collectAssistantBlocks(
  entries: Record<string, any>[],
  start: number,
): [AssistantBlock[], number] {
  const blocks: AssistantBlock[] = []
  const seenKeys = new Set<string>()
  let i = start

  while (i < entries.length) {
    const entry = entries[i]
    const role = entry.message?.role ?? entry.type
    if (role !== 'assistant') break

    const entryTs = entry.timestamp ?? null
    const content = entry.message?.content ?? []
    if (Array.isArray(content)) {
      for (const block of content) {
        const btype = block.type
        if (btype === 'text') {
          const text = (block.text ?? '').trim()
          if (!text || text === 'No response requested.') continue
          const key = `text:${text}`
          if (seenKeys.has(key)) continue
          seenKeys.add(key)
          blocks.push({ kind: 'text', text, tool_call: null, timestamp: entryTs })
        }
        else if (btype === 'thinking') {
          const text = (block.thinking ?? '').trim()
          if (!text) continue
          const key = `thinking:${text}`
          if (seenKeys.has(key)) continue
          seenKeys.add(key)
          blocks.push({ kind: 'thinking', text, tool_call: null, timestamp: entryTs })
        }
        else if (btype === 'tool_use') {
          const toolId = block.id ?? ''
          const key = `tool_use:${toolId}`
          if (seenKeys.has(key)) continue
          seenKeys.add(key)
          blocks.push({
            kind: 'tool_use',
            text: '',
            tool_call: {
              tool_use_id: toolId,
              name: block.name ?? '',
              input: block.input ?? {},
              result: null,
              resultTimestamp: null,
              is_error: false,
            },
            timestamp: entryTs,
          })
        }
      }
    }
    i++
  }

  return [blocks, i]
}

function attachToolResults(
  blocks: AssistantBlock[],
  entries: Record<string, any>[],
  resultStart: number,
): number {
  const pending = new Map<string, ToolCall>()
  for (const b of blocks) {
    if (b.kind === 'tool_use' && b.tool_call)
      pending.set(b.tool_call.tool_use_id, b.tool_call)
  }
  if (pending.size === 0) return resultStart

  let i = resultStart
  while (i < entries.length && pending.size > 0) {
    const entry = entries[i]
    const role = entry.message?.role ?? entry.type
    if (role === 'assistant') break
    if (role === 'user') {
      const content = entry.message?.content ?? ''
      if (Array.isArray(content)) {
        let hasToolResult = false
        for (const block of content) {
          if (block.type === 'tool_result') {
            hasToolResult = true
            const tid = block.tool_use_id ?? ''
            if (pending.has(tid)) {
              const resultContent = block.content
              let resultText: string
              if (Array.isArray(resultContent))
                resultText = resultContent.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('\n')
              else if (typeof resultContent === 'string')
                resultText = resultContent
              else
                resultText = String(resultContent)
              resultText = resultText.replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1')
              const tc = pending.get(tid)!
              tc.result = resultText
              tc.resultTimestamp = entry.timestamp ?? null
              tc.is_error = !!block.is_error
              pending.delete(tid)
            }
          }
        }
        if (!hasToolResult) break
      }
      else { break }
    }
    i++
  }

  return i
}

function filterEmptyTurns(turns: Turn[]): Turn[] {
  const filtered = turns.filter(t => {
    if (t.user_text) return true
    return t.blocks.some(b => {
      if (b.kind === 'tool_use') return true
      if (b.kind === 'text' && b.text && b.text !== 'No response requested.') return true
      if (b.kind === 'thinking' && b.text) return true
      return false
    })
  })
  for (let j = 0; j < filtered.length; j++)
    filtered[j].index = j + 1
  return filtered
}

// ── Format-specific parsers ──

function buildTurnsFromEntries(entries: Record<string, any>[]): Turn[] {
  const turns: Turn[] = []
  let i = 0
  let turnIndex = 0

  while (i < entries.length) {
    const entry = entries[i]
    const role = entry.message?.role ?? entry.type

    if (role === 'user') {
      const content = entry.message?.content ?? ''
      if (isToolResultOnly(content)) { i++; continue }
      let userText = extractText(content)
      const timestamp = entry.timestamp ?? ''
      i++

      while (i < entries.length) {
        const next = entries[i]
        const nextRole = next.message?.role ?? next.type
        if (nextRole !== 'user') break
        const nextContent = next.message?.content ?? ''
        if (isToolResultOnly(nextContent)) break
        const nextText = extractText(nextContent)
        if (nextText) userText = userText ? `${userText}\n${nextText}` : nextText
        i++
      }

      userText = userText.replace(/\[bg-task:\s*(.+)\]/g, '').trim()

      const [assistantBlocks, nextI] = collectAssistantBlocks(entries, i)
      i = nextI
      i = attachToolResults(assistantBlocks, entries, i)

      turnIndex++
      turns.push({ index: turnIndex, user_text: userText, blocks: assistantBlocks, timestamp })
    }
    else if (role === 'assistant') {
      const [assistantBlocks, nextI] = collectAssistantBlocks(entries, i)
      i = nextI
      i = attachToolResults(assistantBlocks, entries, i)

      if (turns.length > 0) {
        turns[turns.length - 1].blocks.push(...assistantBlocks)
      }
      else {
        turnIndex++
        turns.push({ index: turnIndex, user_text: '', blocks: assistantBlocks, timestamp: entry.timestamp ?? '' })
      }
    }
    else { i++ }
  }

  return filterEmptyTurns(turns)
}

function parseCursorEntries(objs: Record<string, any>[]): Record<string, any>[] {
  return objs.filter(obj => !obj.type).map(obj => {
    const role = obj.message?.role ?? obj.role
    if (role !== 'user' && role !== 'assistant') return null
    return {
      type: role,
      message: { role, content: obj.message?.content ?? '' },
      timestamp: obj.timestamp ?? null,
    }
  }).filter(Boolean) as Record<string, any>[]
}

function parseClaudeCodeEntries(objs: Record<string, any>[]): Record<string, any>[] {
  return objs.filter(obj => obj.type === 'user' || obj.type === 'assistant')
}

function parseCursor(objs: Record<string, any>[]): Turn[] {
  const turns = buildTurnsFromEntries(parseCursorEntries(objs))
  // Cursor-specific: reclassify all but last assistant block as thinking
  for (const turn of turns) {
    for (let j = 0; j < turn.blocks.length - 1; j++) {
      if (turn.blocks[j].kind === 'text')
        turn.blocks[j].kind = 'thinking'
    }
  }
  return turns
}

function parseClaudeCode(objs: Record<string, any>[]): Turn[] {
  return buildTurnsFromEntries(parseClaudeCodeEntries(objs))
}

function parseCodex(objs: Record<string, any>[]): Turn[] {
  const isNewFormat = objs.some(e => e.type === 'thread.started' || e.type === 'item.completed')

  if (isNewFormat) {
    const blocks: AssistantBlock[] = []
    let userText = ''

    for (const evt of objs) {
      if (evt.type !== 'item.completed') continue
      const item = evt.item
      if (!item || typeof item !== 'object') continue
      const ts = evt.timestamp ?? null

      if (item.type === 'command_execution') {
        const cmd = typeof item.command === 'string' ? item.command : String(item.command ?? '')
        const cleanCmd = cmd.replace(/^\/bin\/bash\s+-lc\s+/, '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
        blocks.push({
          kind: 'tool_use', text: '',
          tool_call: {
            tool_use_id: item.id ?? '', name: 'Bash',
            input: { command: cleanCmd },
            result: (item.aggregated_output ?? '').trim(),
            resultTimestamp: ts, is_error: item.exit_code != null && item.exit_code !== 0,
          },
          timestamp: ts,
        })
      }
      else if (item.type === 'reasoning') {
        const text = (item.text ?? '').trim()
        if (text) blocks.push({ kind: 'thinking', text, tool_call: null, timestamp: ts })
      }
      else if (item.type === 'agent_message') {
        const text = (item.text ?? '').trim()
        if (text) blocks.push({ kind: 'text', text, tool_call: null, timestamp: ts })
      }
      else if (item.type === 'function_call') {
        const name = item.name ?? 'unknown'
        let input: Record<string, any> = {}
        try { input = JSON.parse(item.arguments ?? '{}') } catch { input = { raw: item.arguments } }
        blocks.push({
          kind: 'tool_use', text: '',
          tool_call: {
            tool_use_id: item.id ?? '', name, input,
            result: (item.output ?? '').trim() || null,
            resultTimestamp: ts, is_error: item.status === 'failed',
          },
          timestamp: ts,
        })
      }
      else if (item.type === 'message' && item.role === 'user') {
        const content = item.content ?? []
        if (Array.isArray(content)) {
          const textParts = content.filter((b: any) => b.type === 'input_text').map((b: any) => b.text ?? '')
          userText = textParts.join('\n').trim()
        }
      }
    }

    if (!blocks.length) return []
    return [{ index: 1, user_text: userText || 'Task', blocks, timestamp: '' }]
  }

  // Legacy codex format
  const turns: Turn[] = []
  let turnIndex = 0
  let currentUserText = ''
  let currentTimestamp = ''
  let currentBlocks: AssistantBlock[] = []
  const pendingCalls = new Map<string, ToolCall>()
  let inTurn = false

  for (const evt of objs) {
    const type = evt.type
    const payload = evt.payload ?? {}
    const ts = evt.timestamp ?? null

    if (type === 'event_msg' && payload.type === 'task_started') {
      inTurn = true; currentUserText = ''; currentTimestamp = ts ?? ''; currentBlocks = []; pendingCalls.clear()
      continue
    }
    if (type === 'event_msg' && payload.type === 'task_complete') {
      if (inTurn) { turnIndex++; turns.push({ index: turnIndex, user_text: currentUserText, blocks: currentBlocks, timestamp: currentTimestamp }) }
      inTurn = false; continue
    }
    if (!inTurn) continue

    if (type === 'event_msg' && payload.type === 'user_message') {
      currentUserText = (payload.message ?? '').trim()
      if (ts) currentTimestamp = ts
      continue
    }

    if (type === 'response_item') {
      const ptype = payload.type
      if (ptype === 'message' && payload.role === 'assistant') {
        const content = payload.content ?? []
        const textParts = Array.isArray(content)
          ? content.filter((b: any) => b.type === 'output_text').map((b: any) => b.text ?? '')
          : []
        const blockText = textParts.join('\n').trim()
        if (blockText) {
          const kind = payload.phase === 'commentary' ? 'thinking' : 'text' as const
          currentBlocks.push({ kind, text: blockText, tool_call: null, timestamp: ts })
        }
      }
      else if (ptype === 'function_call') {
        const callId = payload.call_id ?? ''
        const fnName = payload.name ?? 'unknown'
        let input: Record<string, any> = {}
        try { input = JSON.parse(payload.arguments ?? '{}') } catch { input = { raw: payload.arguments } }
        const toolCall: ToolCall = {
          tool_use_id: callId, name: fnName, input,
          result: null, resultTimestamp: null, is_error: false,
        }
        currentBlocks.push({ kind: 'tool_use', text: '', tool_call: toolCall, timestamp: ts })
        pendingCalls.set(callId, toolCall)
      }
      else if (ptype === 'function_call_output') {
        const callId = payload.call_id ?? ''
        const output = (payload.output ?? '').trim()
        if (pendingCalls.has(callId)) {
          const tc = pendingCalls.get(callId)!
          tc.result = output; tc.resultTimestamp = ts
          pendingCalls.delete(callId)
        }
      }
    }
  }

  if (inTurn && (currentUserText || currentBlocks.length)) {
    turnIndex++
    turns.push({ index: turnIndex, user_text: currentUserText, blocks: currentBlocks, timestamp: currentTimestamp })
  }

  return filterEmptyTurns(turns)
}

// ── Public API ──

// ── Repo-scoped session listing ──

export interface SessionSummary {
  sessionId: string
  filePath: string
  provider: string
  modifiedAt: string
  sizeBytes: number
  /** 首轮用户消息摘要，便于列表中识别会话主题 */
  firstTurnPreview: string | null
}

const PREVIEW_HEAD_BYTES = 96 * 1024

function readFileHeadSync(filePath: string, maxBytes: number): string {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  }
  catch {
    return ''
  }
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, 512 * 1024))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf-8')
  }
  catch {
    return ''
  }
  finally {
    try {
      closeSync(fd)
    }
    catch { /* ignore */ }
  }
}

function tryExtractFirstUserTextFromLine(obj: Record<string, any>): string | null {
  // Codex (new): item.completed + user message
  if (obj.type === 'item.completed' && obj.item?.type === 'message' && obj.item?.role === 'user') {
    const content = obj.item.content ?? []
    if (Array.isArray(content)) {
      const textParts = content
        .filter((b: any) => b.type === 'input_text')
        .map((b: any) => b.text ?? '')
      const userText = textParts.join('\n').trim()
      if (userText) return userText
    }
  }

  // Codex (legacy): event_msg user_message
  if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
    const text = String(obj.payload.message ?? '').trim()
    if (text) return text
  }

  // Claude Code
  if (obj.type === 'user') {
    const content = obj.message?.content ?? obj.content
    if (isToolResultOnly(content)) return null
    const text = extractText(content).trim()
    if (text) return text
  }

  // Cursor (no top-level type)
  if (!obj.type && (obj.role === 'user' || obj.message?.role === 'user')) {
    const content = obj.message?.content ?? obj.content
    if (isToolResultOnly(content)) return null
    const text = extractText(content).trim()
    if (text) return text
  }

  return null
}

/** 从 transcript 文件头部解析首轮用户消息，避免整文件读取 */
export function extractFirstTurnPreview(filePath: string, maxChars = 240): string | null {
  try {
    const head = readFileHeadSync(filePath, PREVIEW_HEAD_BYTES)
    if (!head.trim()) return null
    for (const line of head.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: Record<string, any>
      try {
        obj = JSON.parse(trimmed)
      }
      catch {
        continue
      }
      const text = tryExtractFirstUserTextFromLine(obj)
      if (text) {
        const oneLine = text.replace(/\s+/g, ' ').trim()
        if (oneLine.length <= maxChars) return oneLine
        return `${oneLine.slice(0, Math.max(0, maxChars - 1))}…`
      }
    }
  }
  catch { /* ignore */ }
  return null
}

function pathToProjectKey(localPath: string): string {
  return localPath
    .split('/')
    .filter(seg => seg && /^[\x20-\x7e]+$/.test(seg))
    .join('-')
}

function findMatchingProjectDirs(
  baseDir: string,
  projectKey: string,
): string[] {
  if (!existsSync(baseDir)) return []
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(name => {
        const normalized = name.replace(/^-+/, '').replace(/-+/g, '-')
        return normalized === projectKey || normalized.startsWith(`${projectKey}-`)
      })
  }
  catch { return [] }
}

export function listSessionsForRepo(localPath: string): SessionSummary[] {
  const home = homedir()
  const projectKey = pathToProjectKey(localPath)
  const sessions: SessionSummary[] = []

  // Cursor: ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl
  const cursorBase = join(home, '.cursor', 'projects')
  for (const projDir of findMatchingProjectDirs(cursorBase, projectKey)) {
    const transcriptsDir = join(cursorBase, projDir, 'agent-transcripts')
    if (!existsSync(transcriptsDir)) continue
    try {
      for (const sd of readdirSync(transcriptsDir, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue
        const candidates = [
          join(transcriptsDir, sd.name, `${sd.name}.jsonl`),
          join(transcriptsDir, sd.name, 'transcript.jsonl'),
        ]
        for (const filePath of candidates) {
          if (!existsSync(filePath)) continue
          try {
            const st = statSync(filePath)
            sessions.push({
              sessionId: sd.name,
              filePath,
              provider: 'cursor',
              modifiedAt: st.mtime.toISOString(),
              sizeBytes: st.size,
              firstTurnPreview: extractFirstTurnPreview(filePath),
            })
          }
          catch { /* skip */ }
          break
        }
      }
    }
    catch { /* skip */ }
  }

  // Claude Code: ~/.claude/projects/<project>/<id>.jsonl
  const claudeBase = join(home, '.claude', 'projects')
  for (const projDir of findMatchingProjectDirs(claudeBase, projectKey)) {
    const projPath = join(claudeBase, projDir)
    try {
      for (const f of readdirSync(projPath)) {
        if (!f.endsWith('.jsonl')) continue
        const filePath = join(projPath, f)
        try {
          const st = statSync(filePath)
          if (!st.isFile()) continue
          sessions.push({
            sessionId: f.replace(/\.jsonl$/, ''),
            filePath,
            provider: 'claude-code',
            modifiedAt: st.mtime.toISOString(),
            sizeBytes: st.size,
            firstTurnPreview: extractFirstTurnPreview(filePath),
          })
        }
        catch { /* skip */ }
      }
    }
    catch { /* skip */ }
  }

  sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
  return sessions
}

// ── Single session read ──

export function readTranscript(sessionId: string): TranscriptData | null {
  const match = resolveSessionFile(sessionId)
  if (!match) return null

  try {
    const raw = readFileSync(match.path, 'utf-8')
    const objs: Record<string, any>[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { objs.push(JSON.parse(trimmed)) } catch { /* skip */ }
    }

    if (objs.length === 0) return { sessionId, format: 'unknown', turns: [], filePath: match.path }

    const format = detectFormatFromLines(objs)
    let turns: Turn[]

    switch (format) {
      case 'cursor':
        turns = parseCursor(objs)
        break
      case 'claude-code':
        turns = parseClaudeCode(objs)
        break
      case 'codex':
        turns = parseCodex(objs)
        break
      default:
        turns = buildTurnsFromEntries(objs)
    }

    return { sessionId, format, turns, filePath: match.path }
  }
  catch {
    return null
  }
}
