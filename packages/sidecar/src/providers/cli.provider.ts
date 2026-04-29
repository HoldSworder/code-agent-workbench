import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentEnv,
  buildCliArgs,
  CliRunner,
  resolveBinary,
  type CliBackend,
  type SniProxyPatch,
} from '@code-agent/shared/cli'
import type { AgentProvider, PhaseContext, PhaseResult, RunOptions } from './types'
import { buildSignalPrompt } from './signal-prompt'

const LOG_FILE = join(tmpdir(), 'code-agent-provider.log')
function log(msg: string) {
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

export interface CliProviderConfig {
  type: CliBackend
  binaryPath?: string
  model?: string
  timeoutMs?: number
  resumeSessionId?: string
  maxRetries?: number
  proxyUrl?: string
  sniProxyPatch?: SniProxyPatch
}

const DEFAULT_ACTIVITY_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_MAX_TIMEOUT_MS = 15 * 60 * 1000

export class ExternalCliProvider implements AgentProvider {
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
  }

  // ── Core execution ──

  private async executeOnce(context: PhaseContext, options?: RunOptions): Promise<PhaseResult> {
    const prompt = this.buildPrompt(context)
    const binary = resolveBinary(this.config.type, this.config.binaryPath)
    const { args, stdinData, useStreamJson } = buildCliArgs({
      backend: this.config.type,
      cwd: context.repoPath,
      mode: 'write',
      planMode: context.planMode,
      model: this.config.model,
      resumeSessionId: this.config.resumeSessionId,
      prompt,
    })

    this.abortController = new AbortController()
    const env = buildAgentEnv({
      proxyUrl: this.config.proxyUrl,
      sniProxyPatch: this.config.sniProxyPatch,
    })

    log(`spawn: binary=${binary} type=${this.config.type} cwd=${context.repoPath} stdinLen=${stdinData?.length ?? 0}`)

    const result = await CliRunner.run({
      binary,
      args,
      cwd: context.repoPath,
      stdinData,
      env,
      useStreamJson,
      timeoutMs: this.config.timeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      activityTimeoutMs: DEFAULT_ACTIVITY_TIMEOUT_MS,
      signal: this.abortController.signal,
      onText: text => options?.onChunk?.(text),
      onActivity: entry => options?.onActivity?.(entry),
      onSessionId: (id) => { this.lastSessionId = id },
      logger: log,
    })

    if (result.status === 'success') {
      return { status: 'success', output: result.output, tokenUsage: result.tokenUsage }
    }
    return { status: 'failed', error: result.error, output: result.output }
  }

  private buildPrompt(context: PhaseContext): string {
    if (this.config.resumeSessionId && context.userMessage)
      return context.userMessage

    if (context.phaseId === 'leader-analyze' && context.skillContent)
      return context.skillContent

    const canReadFiles = this.config.type === 'cursor-cli' || this.config.type === 'claude-code'
    return buildPromptFromContext(context, canReadFiles)
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

  if (context.mcpServerNames?.length) {
    sections.push(
      `---\n\n## 可用 MCP Server\n\n以下 MCP Server 已注入到当前工作目录，你可以直接通过 MCP tool 调用它们：\n\n${context.mcpServerNames.map(n => `- \`${n}\``).join('\n')}\n\n**重要**：直接使用 MCP tool 调用上述 server，不要尝试读取技能文件或通过子代理间接调用。`,
    )
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

  if (context.injectedToolPrompts?.length)
    sections.push(`---\n\n${context.injectedToolPrompts.join('\n\n---\n\n')}`)

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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
