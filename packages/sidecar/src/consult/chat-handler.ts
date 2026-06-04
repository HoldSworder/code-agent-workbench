import { randomUUID } from 'node:crypto'
import { Agent, CursorAgentError, type Run, type SDKAgent } from '@cursor/sdk'
import { PromptBuilder } from '@code-agent/shared/util'
import { DEFAULT_CURSOR_MODEL } from '../providers/cursor-sdk.provider'
import type { ConsultConfig, ConsultMessage, ConsultSession, ConsultSessionSummary } from './types'

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
  private activeRuns = new Map<string, Run>()
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
      agentId: null,
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
    const run = this.activeRuns.get(sessionId)
    if (run && run.supports('cancel')) {
      run.cancel().catch(() => {})
    }
    this.activeRuns.delete(sessionId)
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

    if (!this.config.cursorApiKey)
      throw new Error('未配置 Cursor API Key，无法发起咨询对话。')

    session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() })

    // 首轮把只读护栏 + 用户问题合并发送；后续轮次走 Agent.resume，仅发新消息，复用会话上下文。
    // mode:'plan' 让 SDK 在协议层强制只读（不写文件），优于纯 prompt 约束。
    const isFirstTurn = !session.agentId
    const prompt = isFirstTurn
      ? new PromptBuilder().text(READONLY_GUARDRAIL).divider().text(userMessage).build()
      : userMessage

    let agent: SDKAgent
    try {
      agent = isFirstTurn
        ? await Agent.create({
            apiKey: this.config.cursorApiKey,
            model: { id: this.config.model ?? DEFAULT_CURSOR_MODEL },
            local: { cwd: session.repoPath, settingSources: [] },
            mode: 'plan',
          })
        : await Agent.resume(session.agentId!, {
            apiKey: this.config.cursorApiKey,
            local: { cwd: session.repoPath, settingSources: [] },
            mode: 'plan',
          })
    }
    catch (err) {
      if (err instanceof CursorAgentError)
        throw new Error(`Cursor agent 启动失败：${err.message}`)
      throw err
    }
    session.agentId = agent.agentId

    let assistantText = ''
    try {
      const run = await agent.send(prompt)
      this.activeRuns.set(sessionId, run)

      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              assistantText += block.text
              onChunk(block.text)
            }
          }
        }
      }

      const result = await run.wait()
      if (result.status !== 'finished' && !assistantText.trim())
        throw new Error(`Cursor run 执行失败（status=${result.status}）`)

      const cleaned = (assistantText.trim() || result.result?.trim() || '')
      session.messages.push({ role: 'assistant', content: cleaned, timestamp: Date.now() })
      return { assistantMessage: cleaned }
    }
    catch (err) {
      if (err instanceof CursorAgentError)
        throw new Error(`Cursor agent 调用失败：${err.message}`)
      throw err
    }
    finally {
      this.activeRuns.delete(sessionId)
      try { agent.close() } catch {}
    }
  }
}
