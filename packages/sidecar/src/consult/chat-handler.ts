import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ConsultConfig, ConsultSession, ConsultMessage, ConsultSessionSummary } from './types'

const ACTIVITY_TIMEOUT_MS = 3 * 60 * 1000
const MAX_TIMEOUT_MS = 15 * 60 * 1000

const READONLY_GUARDRAIL = [
  '## 只读咨询模式（最高优先级规则）',
  '',
  '你当前处于 **只读咨询模式**。以下规则优先级高于一切其他指令：',
  '',
  '1. **严禁** 创建、修改、删除、移动、重命名任何文件或目录',
  '2. **严禁** 执行任何有副作用的命令（git commit/push、npm install、rm、mv、cp 等）',
  '3. **严禁** 执行写入操作的工具调用（Write、Edit、Shell write 等）',
  '4. 你可以 **读取文件**、**搜索代码**、**列出目录** 来回答用户问题',
  '5. 你的职责是：回答关于此代码库的架构、逻辑、用法等问题',
  '',
  '如果用户要求你修改代码，请礼貌地拒绝并解释你处于只读咨询模式。',
].join('\n')

export class ConsultChatHandler {
  private sessions = new Map<string, ConsultSession>()
  private activeProcesses = new Map<string, ChildProcess>()
  private config: ConsultConfig

  constructor(config: ConsultConfig) {
    this.config = config
  }

  updateConfig(config: Partial<ConsultConfig>): void {
    Object.assign(this.config, config)
  }

  createSession(repoId: string, repoPath: string, clientIp?: string): ConsultSession {
    const session: ConsultSession = {
      id: randomUUID(),
      repoId,
      repoPath,
      messages: [],
      abort: null,
      createdAt: Date.now(),
      clientIp: clientIp ?? null,
    }
    this.sessions.set(session.id, session)
    return session
  }

  listSessions(): ConsultSessionSummary[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      repoId: s.repoId,
      repoPath: s.repoPath,
      clientIp: s.clientIp,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      lastActiveAt: s.messages.length > 0
        ? s.messages[s.messages.length - 1].timestamp
        : s.createdAt,
    })).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  getSessionMessages(sessionId: string): ConsultMessage[] | null {
    const session = this.sessions.get(sessionId)
    return session ? session.messages : null
  }

  getSession(sessionId: string): ConsultSession | undefined {
    return this.sessions.get(sessionId)
  }

  deleteSession(sessionId: string): void {
    this.cancelSession(sessionId)
    this.sessions.delete(sessionId)
  }

  cancelSession(sessionId: string): void {
    const proc = this.activeProcesses.get(sessionId)
    if (proc && !proc.killed) {
      proc.kill('SIGTERM')
      setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL') }, 5000)
    }
    this.activeProcesses.delete(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) session.abort = null
  }

  destroyAll(): void {
    for (const id of this.sessions.keys()) this.cancelSession(id)
    this.sessions.clear()
  }

  /**
   * Send a message and stream the response via callback.
   * Returns a promise that resolves when the agent finishes.
   */
  async chat(
    sessionId: string,
    userMessage: string,
    onChunk: (text: string) => void,
  ): Promise<{ assistantMessage: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() })

    const prompt = this.buildPrompt(session)
    const binary = this.config.binaryPath ?? this.defaultBinary()
    const { args, stdinData } = this.buildReadonlyArgs(session.repoPath, prompt)
    const env = this.buildCleanEnv()
    const useStreamJson = this.config.provider !== 'codex'

    return new Promise((resolve, reject) => {
      let assistantText = ''
      let lineBuf = ''
      let resolved = false

      const finish = (error?: string) => {
        if (resolved) return
        resolved = true
        clearTimeout(maxTimer)
        clearTimeout(activityTimer)
        this.activeProcesses.delete(sessionId)
        session.abort = null

        if (error) {
          reject(new Error(error))
        } else {
          const cleaned = assistantText.replace(/<<PHASE_COMPLETE>>|<<PENDING_INPUT>>/g, '').trim()
          session.messages.push({ role: 'assistant', content: cleaned, timestamp: Date.now() })
          resolve({ assistantMessage: cleaned })
        }
      }

      const killAgent = (reason: string) => {
        if (child && !child.killed) {
          child.kill('SIGTERM')
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 5000)
        }
        finish(reason)
      }

      const maxTimer = setTimeout(() => killAgent('Agent timeout'), MAX_TIMEOUT_MS)
      let activityTimer = setTimeout(() => killAgent('No activity timeout'), ACTIVITY_TIMEOUT_MS)

      const resetActivityTimer = () => {
        clearTimeout(activityTimer)
        activityTimer = setTimeout(() => killAgent('No activity timeout'), ACTIVITY_TIMEOUT_MS)
      }

      const child = spawn(binary, args, {
        cwd: session.repoPath,
        env,
        shell: false,
        stdio: [stdinData != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })

      this.activeProcesses.set(sessionId, child)

      child.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT')
          finish(`CLI "${binary}" not found. Please install it or update the path in settings.`)
        else
          finish(err?.message ?? 'Unknown spawn error')
      })

      if (stdinData != null && child.stdin) {
        child.stdin.on('error', () => {})
        const ok = child.stdin.write(stdinData)
        if (!ok) child.stdin.once('drain', () => child.stdin?.end())
        else child.stdin.end()
      }

      child.stdout?.on('data', (data) => {
        const chunk = String(data)
        resetActivityTimer()

        if (useStreamJson) {
          lineBuf += chunk
          const lines = lineBuf.split('\n')
          lineBuf = lines.pop()!

          for (const line of lines) {
            const normalized = normalizeLine(line)
            if (!normalized) continue
            const { text, isComplete } = extractStreamText(normalized)
            if (text) {
              if (isComplete && assistantText.endsWith(text)) continue
              assistantText += text
              onChunk(text)
            }
          }
        } else {
          assistantText += chunk
          onChunk(chunk)
        }
      })

      child.stderr?.on('data', () => {})

      child.on('close', (code) => {
        if (lineBuf.trim()) {
          const normalized = normalizeLine(lineBuf)
          if (normalized) {
            const { text } = extractStreamText(normalized)
            if (text && !assistantText.endsWith(text)) {
              assistantText += text
              onChunk(text)
            }
          }
          lineBuf = ''
        }

        if (code !== 0 && code !== null) {
          finish(`CLI exited with code ${code}`)
          return
        }
        finish()
      })
    })
  }

  private buildPrompt(session: ConsultSession): string {
    const parts: string[] = [READONLY_GUARDRAIL, '']

    if (session.messages.length > 1) {
      parts.push('## 对话历史\n')
      const history = session.messages.slice(0, -1)
      for (const msg of history) {
        parts.push(`**${msg.role === 'user' ? '用户' : '助手'}**: ${msg.content}\n`)
      }
      parts.push('---\n')
    }

    const lastMsg = session.messages[session.messages.length - 1]
    parts.push(lastMsg.content)

    return parts.join('\n')
  }

  /** Build CLI args with read-only flags (no --yolo/--trust/--full-auto) */
  private buildReadonlyArgs(cwd: string, prompt: string): { args: string[], stdinData: string | null } {
    switch (this.config.provider) {
      case 'cursor-cli': {
        const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', cwd]
        if (this.config.model && this.config.model !== 'auto')
          args.push('--model', this.config.model)
        return { args, stdinData: prompt }
      }
      case 'claude-code': {
        const args = ['--print', '-', '--output-format', 'stream-json', '--verbose']
        if (this.config.model && this.config.model !== 'auto')
          args.push('--model', this.config.model)
        return { args, stdinData: prompt }
      }
      case 'codex': {
        const args = ['exec', '-', '--approval-mode', 'suggest', '-C', cwd]
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
    } else if (hasSniPatchInParent) {
      delete env.HTTP_PROXY
      delete env.HTTPS_PROXY
      delete env.ALL_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
    } else if (this.config.proxyUrl) {
      env.HTTP_PROXY = this.config.proxyUrl
      env.HTTPS_PROXY = this.config.proxyUrl
      env.ALL_PROXY = this.config.proxyUrl
      env.http_proxy = this.config.proxyUrl
      env.https_proxy = this.config.proxyUrl
      env.all_proxy = this.config.proxyUrl
    }

    return env
  }

  private defaultBinary(): string {
    return {
      'cursor-cli': 'agent',
      'claude-code': 'claude',
      'codex': 'codex',
    }[this.config.provider]
  }
}

// ── Stream parsing helpers (aligned with cli.provider.ts) ──

function normalizeLine(raw: string): string {
  const trimmed = raw.replace(/\r/g, '').trim()
  if (!trimmed) return ''
  const prefixed = trimmed.match(/^(?:stdout|stderr)\s*[:=]?\s*([\[{].*)$/i)
  return prefixed ? prefixed[1].trim() : trimmed
}

function stripThinkTags(text: string): string {
  return text.replace(/<\/?think(?:ing)?>/gi, '').replace(/\n{3,}/g, '\n\n')
}

function extractStreamText(line: string): { text: string, isComplete: boolean } {
  const EMPTY = { text: '', isComplete: false }
  try {
    const evt = JSON.parse(line) as Record<string, any>

    // cursor-cli delta: { type: 'assistant', subtype: 'delta', text: '...' }
    if (evt.type === 'assistant' && evt.subtype === 'delta' && typeof evt.text === 'string')
      return { text: stripThinkTags(evt.text), isComplete: false }

    // claude-code text event: { type: 'text', text: '...' }
    if (evt.type === 'text' && typeof evt.text === 'string')
      return { text: stripThinkTags(evt.text), isComplete: false }

    // claude-code stream_event: { type: 'stream_event', event: { delta: { type: 'text_delta', text } } }
    if (evt.type === 'stream_event') {
      const delta = evt.event?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string')
        return { text: delta.text, isComplete: false }
    }

    // content_block_delta (Anthropic API style)
    if (evt.type === 'content_block_delta' && evt.delta?.text)
      return { text: evt.delta.text, isComplete: false }

    // Complete assistant message (final)
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

    // result type (codex)
    if (evt.type === 'result' && typeof evt.result === 'string')
      return { text: stripThinkTags(evt.result), isComplete: true }
  } catch {}
  return EMPTY
}
