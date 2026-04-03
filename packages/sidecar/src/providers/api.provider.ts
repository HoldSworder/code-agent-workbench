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
  private model: string
  private cancelled = false

  constructor(config: ApiProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.model = config.model
  }

  async run(context: PhaseContext): Promise<PhaseResult> {
    this.cancelled = false
    const systemPrompt = `${context.skillContent}\n\n## 执行上下文\n- 阶段: ${context.phaseId}\n- 仓库路径: ${context.repoPath}\n- OpenSpec 目录: ${context.openspecPath}\n- 当前分支: ${context.branchName}`
    const userMessage = context.userMessage ?? '请开始执行此阶段的任务。'

    try {
      const response = await this.client.messages.create({
        model: this.model,
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
}
