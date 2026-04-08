import Anthropic from '@anthropic-ai/sdk'
import type { AgentProvider, PhaseContext, PhaseResult } from './types'

export interface ApiProviderConfig {
  type: 'anthropic' | 'openai-compatible'
  apiKey: string
  baseUrl?: string
  model: string
}

export class ApiProvider implements AgentProvider {
  private client: Anthropic
  private _model: string
  private cancelled = false

  constructor(config: ApiProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this._model = config.model
  }

  get model(): string {
    return this._model
  }

  async run(context: PhaseContext): Promise<PhaseResult> {
    this.cancelled = false
    const systemPrompt = this.buildSystemPrompt(context)
    const userMessage = context.userMessage ?? '请开始执行此阶段的任务。'

    try {
      const response = await this.client.messages.create({
        model: this._model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      })

      if (this.cancelled)
        return { status: 'cancelled' }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n')

      return {
        status: 'success',
        output: text,
        tokenUsage:
          response.usage.input_tokens + response.usage.output_tokens,
      }
    }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'failed', error: message }
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
  }

  private buildSystemPrompt(context: PhaseContext): string {
    const sections: string[] = []

    if (context.requirementTitle) {
      let reqSection = `## 需求\n\n**${context.requirementTitle}**`
      if (context.requirementDescription)
        reqSection += `\n\n${context.requirementDescription}`
      sections.push(reqSection)
    }

    if (context.skillContent)
      sections.push(context.skillContent)

    if (context.invokeSkills?.length) {
      sections.push('---\n\n## 必须调用的外部技能\n\n以下技能的完整内容已注入，你必须在本阶段按 skill 文件中的指令直接执行。')
      for (const skill of context.invokeSkills) {
        sections.push(`### INVOKE SKILL: \`${skill.id}\`\n\n${skill.content}`)
      }
    }

    if (context.invokeCommands?.length) {
      sections.push('---\n\n## 必须执行的 CLI 命令\n\n以下命令由你直接在终端执行（非提示用户执行）：')
      sections.push(context.invokeCommands.map(cmd => `\`\`\`bash\n${cmd}\n\`\`\``).join('\n\n'))
    }

    if (context.gates?.length)
      sections.push(`---\n\n## 门禁规则\n\n以下条件用于判断本阶段的准入与完成，请在执行过程中关注这些条件：\n\n${context.gates.map(g => `- ${g}`).join('\n')}`)

    if (context.guardrails?.length) {
      sections.push(`---\n\n## 护栏规则\n\n${context.guardrails.map(g => `- ${g}`).join('\n')}`)
    }

    sections.push(`---\n\n## 阶段完成状态标记（必须遵守）\n\n你必须在回复的最末尾添加以下标记之一来声明本次执行的完成状态：\n\n- \`<<PHASE_COMPLETE>>\` — 你已完成本阶段的所有产出（文件已写入、命令已执行等）\n- \`<<PENDING_INPUT>>\` — 你需要用户确认或提供更多信息后才能继续\n\n如果上方列出了 ✅ [完成条件]，你必须确保条件中描述的产出物已实际生成后，才能标记 \`<<PHASE_COMPLETE>>\`。\n如果你尚未生成这些产出物（例如在等待用户确认方案），必须标记 \`<<PENDING_INPUT>>\`。\n\n**不要遗漏此标记，它决定了工作流引擎如何推进。**`)

    if (context.conversationHistory?.length) {
      sections.push('---\n\n## 历史对话\n\n以下是本阶段之前的对话记录：')
      for (const turn of context.conversationHistory) {
        const prefix = turn.role === 'user' ? '**用户**' : '**助手**'
        sections.push(`${prefix}:\n${turn.content}`)
      }
    }

    sections.push(`---\n\n## 执行上下文\n- 阶段: ${context.phaseId}\n- 仓库路径: ${context.repoPath}\n- OpenSpec 目录: ${context.openspecPath}\n- 当前分支: ${context.branchName}\n- change-id: ${context.changeId ?? 'N/A'}`)

    return sections.join('\n\n')
  }
}
