import { callAnthropic } from '@code-agent/shared/llm'

export interface LlmCallOptions {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  model?: string
}

/**
 * 评审场景下的轻量 LLM 调用器：复用 sidecar 已经依赖的 Anthropic SDK。
 * 支持通过 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL 环境变量覆盖。
 */
export async function llmCall(opts: LlmCallOptions): Promise<string> {
  const { text } = await callAnthropic({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    model: opts.model,
    maxTokens: opts.maxTokens,
  })
  return text.trim()
}
