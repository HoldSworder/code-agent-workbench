import { randomUUID } from 'node:crypto'
import {
  buildAgentEnv,
  buildCliArgs,
  CliRunner,
  resolveBinary,
} from '@code-agent/shared/cli'
import { PromptBuilder } from '@code-agent/shared/util'
import type { ConsultConfig, ConsultMessage, ConsultSession, ConsultSessionSummary } from './types'

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
  private activeAborts = new Map<string, AbortController>()
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
    const ctl = this.activeAborts.get(sessionId)
    if (ctl) ctl.abort()
    this.activeAborts.delete(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) session.abort = null
  }

  destroyAll(): void {
    for (const id of this.sessions.keys()) this.cancelSession(id)
    this.sessions.clear()
  }

  /**
   * 发送一条用户消息，流式回调 onChunk，promise resolve 时表示 agent 结束。
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
    const binary = resolveBinary(this.config.provider, this.config.binaryPath)
    const { args, stdinData, useStreamJson } = buildCliArgs({
      backend: this.config.provider,
      cwd: session.repoPath,
      mode: 'readonly',
      model: this.config.model,
      prompt,
    })
    const env = buildAgentEnv({
      proxyUrl: this.config.proxyUrl,
      sniProxyPatch: this.config.sniProxyPatch,
    })

    const ctl = new AbortController()
    this.activeAborts.set(sessionId, ctl)

    let assistantText = ''
    const result = await CliRunner.run({
      binary,
      args,
      cwd: session.repoPath,
      stdinData,
      env,
      useStreamJson,
      timeoutMs: MAX_TIMEOUT_MS,
      activityTimeoutMs: ACTIVITY_TIMEOUT_MS,
      signal: ctl.signal,
      onText: (text) => {
        assistantText += text
        onChunk(text)
      },
    })

    this.activeAborts.delete(sessionId)
    session.abort = null

    if (result.status !== 'success') {
      throw new Error(result.error ?? 'Agent failed')
    }

    const cleaned = (result.output || assistantText).replace(/<<PHASE_COMPLETE>>|<<PENDING_INPUT>>/g, '').trim()
    session.messages.push({ role: 'assistant', content: cleaned, timestamp: Date.now() })
    return { assistantMessage: cleaned }
  }

  private buildPrompt(session: ConsultSession): string {
    const builder = new PromptBuilder().text(READONLY_GUARDRAIL)

    if (session.messages.length > 1) {
      const history = session.messages.slice(0, -1)
      const formatted = history
        .map(m => `**${m.role === 'user' ? '用户' : '助手'}**: ${m.content}`)
        .join('\n')
      builder.section('对话历史', formatted).divider()
    }

    const lastMsg = session.messages[session.messages.length - 1]
    builder.text(lastMsg.content)
    return builder.build()
  }
}
