import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from './types'

export interface CliProviderConfig {
  type: 'claude-code' | 'cursor-cli' | 'codex'
  binaryPath?: string
  model?: string
  timeoutMs?: number
  resumeSessionId?: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 90 * 1000       // no *visible text* for 90s → kill
const DEFAULT_FIRST_TEXT_TIMEOUT_MS = 3 * 60 * 1000  // first visible text must arrive within 3 min
const DEFAULT_MAX_TIMEOUT_MS = 5 * 60 * 1000    // absolute cap: 5 min
const GRACE_KILL_MS = 5_000

export class ExternalCliProvider implements AgentProvider {
  private childProcess: ChildProcess | null = null
  private config: CliProviderConfig
  private lastSessionId: string | null = null

  constructor(config: CliProviderConfig) {
    this.config = config
  }

  get sessionId(): string | null {
    return this.lastSessionId
  }

  run(context: PhaseContext, options?: RunOptions): Promise<PhaseResult> {
    const prompt = this.buildPrompt(context)
    const binary = this.config.binaryPath ?? this.defaultBinary()
    const useStreamJson = this.config.type !== 'codex'

    return new Promise((resolve) => {
      const { args, stdinData } = this.buildSpawnArgs(context.repoPath, prompt)
      const env = this.buildCleanEnv()

      let stdout = ''
      let stderr = ''
      let lineBuf = ''
      let assistantText = ''
      let resolved = false
      let gotFirstText = false
      let maxTimer: ReturnType<typeof setTimeout>
      let idleTimer: ReturnType<typeof setTimeout>
      let firstTextTimer: ReturnType<typeof setTimeout>

      const finish = (result: PhaseResult) => {
        if (resolved) return
        resolved = true
        clearTimeout(maxTimer)
        clearTimeout(idleTimer)
        clearTimeout(firstTextTimer)
        resolve(result)
      }

      const killAgent = (reason: string) => {
        if (this.childProcess) {
          this.childProcess.kill('SIGTERM')
          setTimeout(() => this.childProcess?.kill('SIGKILL'), GRACE_KILL_MS)
        }
        finish({ status: 'failed', error: reason })
      }

      const maxMs = this.config.timeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
      maxTimer = setTimeout(() => {
        killAgent(`Agent exceeded maximum time limit (${maxMs / 1000}s)`)
      }, maxMs)

      const idleMs = DEFAULT_IDLE_TIMEOUT_MS

      firstTextTimer = setTimeout(() => {
        if (!gotFirstText)
          killAgent(`Agent produced no visible text within ${DEFAULT_FIRST_TEXT_TIMEOUT_MS / 1000}s`)
      }, DEFAULT_FIRST_TEXT_TIMEOUT_MS)

      const startIdleTimeout = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          killAgent(`Agent idle timeout — no visible text for ${idleMs / 1000}s`)
        }, idleMs)
      }

      this.childProcess = spawn(binary, args, {
        cwd: context.repoPath,
        env,
        shell: false,
        stdio: [stdinData != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })

      if (stdinData != null && this.childProcess.stdin) {
        this.childProcess.stdin.write(stdinData)
        this.childProcess.stdin.end()
      }

      this.childProcess.stdout?.on('data', (data) => {
        const chunk = String(data)
        stdout += chunk

        if (useStreamJson && options?.onChunk) {
          lineBuf += chunk
          const lines = lineBuf.split('\n')
          lineBuf = lines.pop()!
          for (const line of lines) {
            const normalized = normalizeLine(line)
            if (!normalized) continue
            this.extractSessionId(normalized)
            const { text, isComplete } = extractStreamText(normalized)
            if (text) {
              if (isComplete && assistantText.endsWith(text)) continue
              assistantText += text
              options.onChunk(text)
              if (!gotFirstText) {
                gotFirstText = true
                clearTimeout(firstTextTimer)
              }
              startIdleTimeout()
            }
          }
        }
        else {
          options?.onChunk?.(chunk)
          if (!gotFirstText) {
            gotFirstText = true
            clearTimeout(firstTextTimer)
          }
          startIdleTimeout()
        }
      })

      this.childProcess.stderr?.on('data', (data) => {
        stderr += String(data)
      })

      this.childProcess.on('error', (err) => {
        this.childProcess = null
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          finish({ status: 'failed', error: `CLI "${binary}" not found. Please install it or update the path in settings.` })
        }
        else {
          finish({ status: 'failed', error: err?.message ?? 'Unknown spawn error' })
        }
      })

      this.childProcess.on('close', (code, signal) => {
        this.childProcess = null

        if (lineBuf.trim()) {
          const normalized = normalizeLine(lineBuf)
          if (normalized) {
            this.extractSessionId(normalized)
            const { text } = extractStreamText(normalized)
            if (text) assistantText += text
          }
          lineBuf = ''
        }

        if (signal) {
          finish({ status: 'failed', error: stderr || `Killed by signal: ${signal}` })
          return
        }

        if (code !== 0 && code !== null) {
          finish({ status: 'failed', error: stderr || `Exit code: ${code}` })
          return
        }

        if (useStreamJson) {
          finish({
            status: 'success',
            output: assistantText || parseStreamResult(stdout),
            tokenUsage: extractTokenUsage(stdout),
          })
        }
        else {
          const output = parseJsonOutput(stdout)
          finish({
            status: 'success',
            output: output.text,
            tokenUsage: output.tokenUsage,
          })
        }
      })
    })
  }

  async cancel(): Promise<void> {
    if (!this.childProcess) return
    this.childProcess.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.childProcess?.kill('SIGKILL')
        resolve()
      }, GRACE_KILL_MS)
      this.childProcess?.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // ── Spawn args per backend ──

  private buildSpawnArgs(cwd: string, prompt: string): { args: string[], stdinData: string | null } {
    switch (this.config.type) {
      case 'cursor-cli': {
        const args = ['agent', '-p', '--output-format', 'stream-json', '--stream-partial-output', '--yolo', '--trust', '--workspace', cwd]
        if (this.config.model)
          args.push('--model', this.config.model)
        if (this.config.resumeSessionId)
          args.push('--resume', this.config.resumeSessionId)
        return { args, stdinData: prompt }
      }
      case 'claude-code': {
        const args = ['--print', '-', '--output-format', 'stream-json', '--verbose']
        if (this.config.model)
          args.push('--model', this.config.model)
        if (this.config.resumeSessionId)
          args.push('--resume', this.config.resumeSessionId)
        return { args, stdinData: prompt }
      }
      case 'codex': {
        const args = ['-p', prompt, '--output-format', 'json']
        if (this.config.model)
          args.push('--model', this.config.model)
        return { args, stdinData: null }
      }
    }
  }

  // ── Environment ──

  private buildCleanEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue
      if (k === 'NODE_OPTIONS') continue
      if (k.startsWith('npm_')) continue
      if (k.startsWith('ELECTRON_')) continue
      env[k] = v
    }
    return env
  }

  // ── Session ID extraction ──

  private extractSessionId(line: string): void {
    try {
      const evt = JSON.parse(line) as Record<string, any>
      const id = evt.session_id ?? evt.sessionId ?? evt.sessionID
        ?? evt.message?.session_id
      if (typeof id === 'string' && id)
        this.lastSessionId = id
    }
    catch { /* ignore */ }
  }

  // ── Prompt builder ──

  private buildPrompt(context: PhaseContext): string {
    // Resume mode: only user message matters, agent already has full context
    if (this.config.resumeSessionId && context.userMessage) {
      return context.userMessage
    }

    const sections: string[] = []
    const canReadFiles = this.config.type === 'cursor-cli' || this.config.type === 'claude-code'

    if (context.requirementTitle) {
      let reqSection = `## 需求\n\n**${context.requirementTitle}**`
      if (context.requirementDescription)
        reqSection += `\n\n${context.requirementDescription}`
      sections.push(reqSection)
    }

    if (context.skillContent)
      sections.push(context.skillContent)

    if (context.invokeSkills?.length) {
      if (canReadFiles) {
        sections.push('---\n\n## 必须调用的外部技能\n\n请先读取以下技能文件，然后按其中的指令执行：')
        for (const skill of context.invokeSkills) {
          sections.push(`- \`${skill.id}\`: 请用工具读取此技能的完整内容后执行`)
        }
      }
      else {
        sections.push('---\n\n## 必须调用的外部技能')
        for (const skill of context.invokeSkills) {
          sections.push(`### INVOKE SKILL: \`${skill.id}\`\n\n${skill.content}`)
        }
      }
    }

    if (context.invokeCommands?.length) {
      sections.push('---\n\n## 必须执行的 CLI 命令\n\n以下命令由你直接在终端执行：')
      sections.push(context.invokeCommands.map(cmd => `\`\`\`bash\n${cmd}\n\`\`\``).join('\n\n'))
    }

    if (context.guardrails?.length)
      sections.push(`---\n\n## 护栏规则\n\n${context.guardrails.map(g => `- ${g}`).join('\n')}`)

    if (context.conversationHistory?.length) {
      sections.push('---\n\n## 历史对话')
      for (const turn of context.conversationHistory) {
        const prefix = turn.role === 'user' ? '**用户**' : '**助手**'
        sections.push(`${prefix}:\n${turn.content}`)
      }
    }

    if (context.userMessage)
      sections.push(`---\n\n## 用户最新反馈\n${context.userMessage}`)

    sections.push(`---\n\n## 上下文\n- 工作目录: ${context.repoPath}\n- OpenSpec: ${context.openspecPath}\n- 分支: ${context.branchName}\n- change-id: ${context.changeId ?? 'N/A'}`)

    return sections.join('\n\n')
  }

  private defaultBinary(): string {
    return {
      'claude-code': 'claude',
      'cursor-cli': 'cursor',
      'codex': 'codex',
    }[this.config.type]
  }
}

// ── Pure parsing functions ──

/** Strip optional `stdout:` / `stderr:` prefixes from cursor stream lines */
function normalizeLine(raw: string): string {
  const trimmed = raw.replace(/\r/g, '').trim()
  if (!trimmed) return ''
  const prefixed = trimmed.match(/^(?:stdout|stderr)\s*[:=]?\s*([\[{].*)$/i)
  return prefixed ? prefixed[1].trim() : trimmed
}

/** Strip `<think>`/`<thinking>` tags from content (ref: AionUi ThinkTagDetector) */
function stripThinkTags(text: string): string {
  return text
    .replace(/<\/?think(?:ing)?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * Extract readable text from a single stream-json NDJSON event.
 *
 * Returns `{ text, isComplete }`:
 * - Deltas (`subtype: "delta"`) → `isComplete = false`, streamed incrementally
 * - Complete assistant messages (no subtype) → `isComplete = true`, caller must
 *   deduplicate against already-delivered delta text
 *
 * Cursor agent may only send complete messages without prior deltas;
 * Claude Code sends deltas followed by a duplicate complete message.
 */
function extractStreamText(line: string): { text: string, isComplete: boolean } {
  const EMPTY = { text: '', isComplete: false }
  try {
    const evt = JSON.parse(line) as Record<string, any>

    // Incremental delta
    if (evt.type === 'assistant' && evt.subtype === 'delta' && typeof evt.text === 'string')
      return { text: stripThinkTags(evt.text), isComplete: false }

    // Simple text event
    if (evt.type === 'text' && typeof evt.text === 'string')
      return { text: stripThinkTags(evt.text), isComplete: false }

    // Claude stream_event → content_block_delta
    if (evt.type === 'stream_event') {
      const delta = evt.event?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string')
        return { text: delta.text, isComplete: false }
    }

    // Complete assistant message (cursor agent often sends ONLY this, no deltas)
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
  }
  catch { /* not valid JSON, skip */ }
  return EMPTY
}

/** Fallback: reassemble text from all stdout lines */
function parseStreamResult(stdout: string): string {
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

      // complete assistant message — keep as fallback if no deltas collected
      if (evt.type === 'assistant' && !evt.subtype) {
        const blocks = evt.message?.content ?? evt.content
        if (Array.isArray(blocks)) {
          lastCompleteAssistant = stripThinkTags(
            blocks
              .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text)
              .join(''),
          )
        }
        else if (typeof blocks === 'string') {
          lastCompleteAssistant = stripThinkTags(blocks)
        }
        continue
      }
    }
    catch { /* skip */ }

    const text = extractStreamText(normalized)
    if (text) deltas.push(text)
  }

  if (deltas.length > 0) return deltas.join('')
  if (lastCompleteAssistant) return lastCompleteAssistant
  return stdout
}

/** Extract token usage from result event */
function extractTokenUsage(stdout: string): number | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = normalizeLine(lines[i])
    if (!line) continue
    try {
      const evt = JSON.parse(line) as Record<string, any>
      if (evt.type === 'result') {
        return evt.total_tokens ?? evt.usage?.total_tokens ?? evt.num_tokens
      }
    }
    catch { /* skip */ }
  }
  return undefined
}

/** Parse codex-style single JSON output */
function parseJsonOutput(stdout: string): { text: string, tokenUsage?: number } {
  try {
    const json = JSON.parse(stdout) as Record<string, any>
    return {
      text: json.result ?? json.output ?? stdout,
      tokenUsage: json.usage?.total_tokens,
    }
  }
  catch {
    return { text: stdout }
  }
}
