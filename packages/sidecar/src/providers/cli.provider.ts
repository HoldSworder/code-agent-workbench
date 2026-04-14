import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from './types'
import { buildSignalPrompt } from './signal-prompt'

const LOG_FILE = join(tmpdir(), 'code-agent-provider.log')
function log(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

export interface CliProviderConfig {
  type: 'claude-code' | 'cursor-cli' | 'codex'
  binaryPath?: string
  model?: string
  timeoutMs?: number
  resumeSessionId?: string
  maxRetries?: number
  proxyUrl?: string
  sniProxyPatch?: {
    scriptPath: string
    socks5Host: string
    socks5Port: number
  }
}

const DEFAULT_ACTIVITY_TIMEOUT_MS = 3 * 60 * 1000 // no stdout at all for 3 min → kill
const DEFAULT_MAX_TIMEOUT_MS = 15 * 60 * 1000     // absolute cap: 15 min
const GRACE_KILL_MS = 5_000

export class ExternalCliProvider implements AgentProvider {
  private childProcess: ChildProcess | null = null
  private abortController: AbortController | null = null
  private config: CliProviderConfig
  private lastSessionId: string | null = null

  constructor(config: CliProviderConfig) {
    this.config = config
  }

  get sessionId(): string | null {
    return this.lastSessionId
  }

  get model(): string | null {
    return this.config.model ?? null
  }

  async run(context: PhaseContext, options?: RunOptions): Promise<PhaseResult> {
    const maxRetries = this.config.maxRetries ?? 1
    let lastError = ''

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000)
        await sleep(delay)
      }

      const result = await this.executeOnce(context, options)

      if (result.status === 'success') return result

      lastError = result.error ?? 'Unknown error'
      const retryable = lastError.includes('timeout') || lastError.includes('ENOENT')
      if (!retryable) return result
    }

    return { status: 'failed', error: lastError }
  }

  async cancel(): Promise<void> {
    this.abortController?.abort()
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

  // ── Core execution ──

  private executeOnce(context: PhaseContext, options?: RunOptions): Promise<PhaseResult> {
    const prompt = this.buildPrompt(context)
    const binary = this.config.binaryPath ?? this.defaultBinary()
    const useStreamJson = this.config.type !== 'codex'
    const { args, stdinData } = this.buildSpawnArgs(context.repoPath, prompt)

    this.abortController = new AbortController()
    const { signal } = this.abortController

    log(`spawn: binary=${binary} type=${this.config.type} cwd=${context.repoPath}`)
    log(`spawn: args=${JSON.stringify(args.slice(0, 10))} stdinLen=${stdinData?.length ?? 0}`)

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let lineBuf = ''
      let assistantText = ''
      let resolved = false
      let stdoutChunks = 0
      let lastActivityEntry = ''

      const finish = (result: PhaseResult) => {
        if (resolved) return
        resolved = true
        clearTimeout(maxTimer)
        clearTimeout(activityTimer)
        log(`finish: status=${result.status} stdoutChunks=${stdoutChunks} assistantLen=${assistantText.length} error=${result.error ?? 'none'}`)
        resolve(result)
      }

      const killAgent = (reason: string) => {
        log(`killAgent: ${reason} (stderrLen=${stderr.length})`)
        if (stderr) log(`stderr tail: ${stderr.slice(-500)}`)
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGTERM')
          setTimeout(() => {
            if (this.childProcess && !this.childProcess.killed)
              this.childProcess.kill('SIGKILL')
          }, GRACE_KILL_MS)
        }
        finish({ status: 'failed', error: reason })
      }

      // Timer 1: absolute max — hard ceiling regardless of activity
      const maxMs = this.config.timeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
      const maxTimer = setTimeout(
        () => killAgent(`Agent exceeded maximum time limit (${maxMs / 1000}s)`),
        maxMs,
      )

      // Timer 2: activity-based — resets on ANY stdout data
      const activityMs = DEFAULT_ACTIVITY_TIMEOUT_MS
      let activityTimer = setTimeout(
        () => killAgent(`No agent activity for ${activityMs / 1000}s`),
        activityMs,
      )

      const resetActivityTimer = () => {
        clearTimeout(activityTimer)
        activityTimer = setTimeout(
          () => killAgent(`No agent activity for ${activityMs / 1000}s`),
          activityMs,
        )
      }

      // Abort signal listener
      const onAbort = () => killAgent('Cancelled')
      signal.addEventListener('abort', onAbort, { once: true })

      this.childProcess = spawn(binary, args, {
        cwd: context.repoPath,
        env: this.buildCleanEnv(),
        shell: false,
        stdio: [stdinData != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })

      log(`spawned: pid=${this.childProcess.pid}`)

      this.childProcess.on('error', (err) => {
        this.childProcess = null
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT')
          finish({ status: 'failed', error: `CLI "${binary}" not found. Please install it or update the path in settings.` })
        else
          finish({ status: 'failed', error: err?.message ?? 'Unknown spawn error' })
      })

      // Write prompt via stdin for large payload support
      if (stdinData != null && this.childProcess.stdin) {
        this.childProcess.stdin.on('error', () => { /* swallow broken pipe */ })
        const ok = this.childProcess.stdin.write(stdinData)
        if (!ok) {
          this.childProcess.stdin.once('drain', () => this.childProcess?.stdin?.end())
        }
        else {
          this.childProcess.stdin.end()
        }
      }

      // ── stdout processing ──
      let debugFirstChunks = 0
      this.childProcess.stdout?.on('data', (data) => {
        const chunk = String(data)
        stdout += chunk
        stdoutChunks++
        resetActivityTimer()

        if (debugFirstChunks < 3) {
          debugFirstChunks++
          log(`stdout chunk #${debugFirstChunks}: ${chunk.slice(0, 300)}`)
        }

        if (useStreamJson) {
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
              options?.onChunk?.(text)
            }

            const activity = extractActivityEntry(normalized)
            if (activity && activity !== lastActivityEntry) {
              lastActivityEntry = activity
              options?.onActivity?.(activity + '\n')
            }
          }
        }
        else {
          options?.onChunk?.(chunk)
          options?.onActivity?.(chunk)
        }
      })

      this.childProcess.stderr?.on('data', (data) => {
        stderr += String(data)
      })

      this.childProcess.on('close', (code, sig) => {
        log(`close: code=${code} signal=${sig} stdoutLen=${stdout.length} stderrLen=${stderr.length}`)
        this.childProcess = null
        signal.removeEventListener('abort', onAbort)

        // Flush remaining line buffer
        if (lineBuf.trim()) {
          const normalized = normalizeLine(lineBuf)
          if (normalized) {
            this.extractSessionId(normalized)
            const { text } = extractStreamText(normalized)
            if (text) {
              assistantText += text
              options?.onChunk?.(text)
            }
            const activity = extractActivityEntry(normalized)
            if (activity && activity !== lastActivityEntry) {
              lastActivityEntry = activity
              options?.onActivity?.(activity + '\n')
            }
          }
          lineBuf = ''
        }

        if (sig) {
          finish({ status: 'failed', error: stderr || `Killed by signal: ${sig}`, output: assistantText || stdout.slice(0, 2000) })
          return
        }
        if (code !== 0 && code !== null) {
          finish({ status: 'failed', error: stderr || `Exit code: ${code}`, output: assistantText || stdout.slice(0, 2000) })
          return
        }

        if (useStreamJson) {
          const finalOutput = assistantText || parseStreamResult(stdout)
          log(`close: assistantTextLen=${assistantText.length} parseStreamLen=${assistantText ? 0 : finalOutput.length} stdoutLen=${stdout.length}`)
          if (!assistantText && stdout.length > 0)
            log(`close: stdout first 500: ${stdout.slice(0, 500)}`)
          finish({
            status: 'success',
            output: finalOutput,
            tokenUsage: extractTokenUsage(stdout),
          })
        }
        else {
          const output = parseJsonOutput(stdout)
          finish({ status: 'success', output: output.text, tokenUsage: output.tokenUsage })
        }
      })
    })
  }

  // ── Spawn args per backend ──

  private buildSpawnArgs(cwd: string, prompt: string): { args: string[], stdinData: string | null } {
    switch (this.config.type) {
      case 'cursor-cli': {
        const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--yolo', '--trust', '--workspace', cwd]
        if (this.config.model && this.config.model !== 'auto')
          args.push('--model', this.config.model)
        if (this.config.resumeSessionId)
          args.push('--resume', this.config.resumeSessionId)
        return { args, stdinData: prompt }
      }
      case 'claude-code': {
        const args = ['--print', '-', '--output-format', 'stream-json', '--verbose']
        if (this.config.model && this.config.model !== 'auto')
          args.push('--model', this.config.model)
        if (this.config.resumeSessionId)
          args.push('--resume', this.config.resumeSessionId)
        return { args, stdinData: prompt }
      }
      case 'codex': {
        const args = ['exec', '-', '--full-auto', '-C', cwd]
        if (this.config.model && this.config.model !== 'auto')
          args.push('--model', this.config.model)
        return { args, stdinData: prompt }
      }
    }
  }

  private buildCleanEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    const parentNodeOptions = process.env.NODE_OPTIONS ?? ''
    const hasSniPatchInParent = parentNodeOptions.includes('agent-socks5-patch')

    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue
      if (k === 'NODE_OPTIONS' && !hasSniPatchInParent) continue
      if (k.startsWith('npm_')) continue
      if (k.startsWith('ELECTRON_')) continue
      env[k] = v
    }

    const patch = this.config.sniProxyPatch
    if (patch) {
      env.NODE_OPTIONS = `--require "${patch.scriptPath}"`
      env.AGENT_SOCKS5_HOST = patch.socks5Host
      env.AGENT_SOCKS5_PORT = String(patch.socks5Port)
      delete env.HTTP_PROXY
      delete env.HTTPS_PROXY
      delete env.ALL_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
    }
    else if (hasSniPatchInParent) {
      delete env.HTTP_PROXY
      delete env.HTTPS_PROXY
      delete env.ALL_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
    }
    else if (this.config.proxyUrl) {
      env.HTTP_PROXY = this.config.proxyUrl
      env.HTTPS_PROXY = this.config.proxyUrl
      env.ALL_PROXY = this.config.proxyUrl
      env.http_proxy = this.config.proxyUrl
      env.https_proxy = this.config.proxyUrl
      env.all_proxy = this.config.proxyUrl
    }

    return env
  }

  private extractSessionId(line: string): void {
    try {
      const evt = JSON.parse(line) as Record<string, any>
      const id = evt.session_id ?? evt.sessionId ?? evt.sessionID ?? evt.message?.session_id
      if (typeof id === 'string' && id)
        this.lastSessionId = id
    }
    catch { /* ignore */ }
  }

  private buildPrompt(context: PhaseContext): string {
    if (this.config.resumeSessionId && context.userMessage)
      return context.userMessage

    if (context.phaseId === 'leader-analyze' && context.skillContent)
      return context.skillContent

    const canReadFiles = this.config.type === 'cursor-cli' || this.config.type === 'claude-code'
    return buildPromptFromContext(context, canReadFiles)
  }

  private defaultBinary(): string {
    return {
      'claude-code': 'claude',
      'cursor-cli': 'agent',
      'codex': 'codex',
    }[this.config.type]
  }
}

// ── Prompt builder (exported for preview) ──

export function buildPromptFromContext(context: PhaseContext, canReadFiles = true): string {
  const sections: string[] = []

  if (context.requirementTitle) {
    let reqSection = `## 需求\n\n**${context.requirementTitle}**`
    if (context.requirementSourceUrl)
      reqSection += `\n\n> 飞书项目链接: ${context.requirementSourceUrl}`
    if (context.requirementDocUrl)
      reqSection += `\n\n> 飞书需求文档: ${context.requirementDocUrl}`
    if (context.requirementDescription)
      reqSection += `\n\n${context.requirementDescription}`
    sections.push(reqSection)
  }

  if (context.skillContent)
    sections.push(context.skillContent)

  if (context.invokeSkills?.length) {
    if (canReadFiles) {
      sections.push('---\n\n## 必须调用的外部技能\n\n请先读取以下技能文件，然后按其中的指令执行：')
      for (const skill of context.invokeSkills)
        sections.push(`- \`${skill.id}\`: 请用工具读取此技能的完整内容后执行`)
    }
    else {
      sections.push('---\n\n## 必须调用的外部技能')
      for (const skill of context.invokeSkills)
        sections.push(`### INVOKE SKILL: \`${skill.id}\`\n\n${skill.content}`)
    }
  }

  if (context.invokeCommands?.length) {
    sections.push('---\n\n## 必须执行的 CLI 命令\n\n以下命令由你直接在终端执行：')
    sections.push(context.invokeCommands.map(cmd => `\`\`\`bash\n${cmd}\n\`\`\``).join('\n\n'))
  }

  if (context.gates?.length)
    sections.push(`---\n\n## 门禁规则\n\n以下条件用于判断本阶段的准入与完成，请在执行过程中关注这些条件：\n\n${context.gates.map(g => `- ${g}`).join('\n')}`)

  sections.push(buildSignalPrompt(context))

  if (context.externalRules?.length) {
    sections.push('---\n\n## 外部规则\n\n以下规则为跨阶段共享的强制约束，必须在本阶段执行过程中遵守：')
    for (const rule of context.externalRules)
      sections.push(rule.content)
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

  const ctxLines: string[] = []
  if (context.openspecPath) ctxLines.push(`- OpenSpec: ${context.openspecPath}`)
  if (context.branchName) ctxLines.push(`- 分支: ${context.branchName}`)
  if (context.changeId) ctxLines.push(`- change-id: ${context.changeId}`)
  if (ctxLines.length > 0) {
    ctxLines.unshift(`- 工作目录: ${context.repoPath}`)
    sections.push(`---\n\n## 上下文\n${ctxLines.join('\n')}`)
  }

  return sections.join('\n\n')
}

// ── Pure parsing helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function normalizeLine(raw: string): string {
  const trimmed = raw.replace(/\r/g, '').trim()
  if (!trimmed) return ''
  const prefixed = trimmed.match(/^(?:stdout|stderr)\s*[:=]?\s*([\[{].*)$/i)
  return prefixed ? prefixed[1].trim() : trimmed
}

function stripThinkTags(text: string): string {
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
 * Extract a human-readable activity log entry from a stream-json line.
 * Returns null for events that don't warrant a log entry.
 */
function extractActivityEntry(line: string): string | null {
  try {
    const evt = JSON.parse(line) as Record<string, any>
    const ts = activityTimestamp()

    // ── cursor-cli: thinking delta (agent reasoning, very frequent) ──
    if (evt.type === 'thinking' && evt.subtype === 'delta' && typeof evt.text === 'string') {
      const snippet = evt.text.replace(/\n/g, ' ').trim().slice(-60)
      if (snippet) return `[${ts}] 🧠 ${snippet}`
      return null
    }

    // ── cursor-cli: text delta ──
    if (evt.type === 'assistant' && evt.subtype === 'delta' && typeof evt.text === 'string') {
      const snippet = stripThinkTags(evt.text).replace(/\n/g, ' ').slice(0, 80)
      if (snippet.trim()) return `[${ts}] ✍️ ${snippet}`
      return null
    }

    // ── cursor-cli: cumulative assistant message (parse content blocks) ──
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

    // ── cursor-cli / generic: user message ──
    if (evt.type === 'user')
      return `[${ts}] 📨 User message received`

    // ── cursor-cli / generic: system event ──
    if (evt.type === 'system') {
      if (evt.subtype === 'init')
        return `[${ts}] ⚙️ Init | Model: ${evt.model ?? 'unknown'}`
      return `[${ts}] ⚙️ System: ${evt.subtype ?? evt.message ?? ''}`
    }

    // ── claude-code: text event ──
    if (evt.type === 'text' && typeof evt.text === 'string') {
      const snippet = stripThinkTags(evt.text).replace(/\n/g, ' ').slice(0, 80)
      if (snippet.trim()) return `[${ts}] ✍️ ${snippet}`
      return null
    }

    // ── claude-code / generic: standalone tool_use event ──
    if (evt.type === 'tool_use' || evt.subtype === 'tool_use') {
      const tool = extractToolName(evt)
      const input = extractToolInput(evt)
      return `[${ts}] 🔧 Tool: ${tool}${input ? ` → ${input}` : ''}`
    }

    if (evt.type === 'assistant' && evt.subtype === 'tool_use_delta')
      return null

    // ── claude-code / generic: tool result ──
    if (evt.type === 'tool_result' || evt.subtype === 'tool_result') {
      const len = typeof evt.output === 'string' ? evt.output.length : (evt.content?.length ?? 0)
      const status = evt.is_error ? '❌' : '✅'
      return `[${ts}] ${status} Tool result${len ? ` (${len} chars)` : ''}`
    }

    // ── claude-code: stream_event wrapper ──
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

    // ── Anthropic API: content_block_delta ──
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

function extractStreamText(line: string): { text: string, isComplete: boolean } {
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
  catch { /* not valid JSON */ }
  return EMPTY
}

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

function extractTokenUsage(stdout: string): number | undefined {
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

function parseJsonOutput(stdout: string): { text: string, tokenUsage?: number } {
  try {
    const json = JSON.parse(stdout) as Record<string, any>
    return { text: json.result ?? json.output ?? stdout, tokenUsage: json.usage?.total_tokens }
  }
  catch {
    return { text: stdout }
  }
}
