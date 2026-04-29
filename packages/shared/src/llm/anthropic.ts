import Anthropic from '@anthropic-ai/sdk'

export interface CreateLlmClientOptions {
  /** 显式 API Key；不传则回退 ANTHROPIC_API_KEY。 */
  apiKey?: string | null
  /** 自定义 baseURL；不传则回退 ANTHROPIC_BASE_URL。 */
  baseUrl?: string | null
}

/**
 * 创建一个已配置好 apiKey/baseURL 的 Anthropic 客户端。
 * 缺少 apiKey 时立刻抛错（避免延迟到 API 调用时才暴露）。
 */
export function createLlmClient(opts: CreateLlmClientOptions = {}): Anthropic {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 未配置；LLM 功能不可用')
  const baseURL = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL
  return new Anthropic({ apiKey, baseURL: baseURL ?? undefined })
}

export interface CallAnthropicOptions {
  systemPrompt: string
  userPrompt: string
  model?: string
  maxTokens?: number
  /** 已有客户端时直接复用，跳过校验 apiKey。 */
  client?: Anthropic
  apiKey?: string
  baseUrl?: string
}

export interface CallAnthropicResult {
  text: string
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

const DEFAULT_MODEL = 'claude-3-5-sonnet-latest'
const DEFAULT_MAX_TOKENS = 4096

/**
 * 单轮 system+user → text 的便捷封装。
 *
 * 命中规则：
 * - model 优先用入参，其次 ANTHROPIC_MODEL，最后默认 sonnet-latest；
 * - 仅返回 text block 拼接结果（去掉其他类型 block）；
 * - usage 字段同时保留 input/output/total，方便上层 telemetry。
 */
export async function callAnthropic(opts: CallAnthropicOptions): Promise<CallAnthropicResult> {
  const client = opts.client ?? createLlmClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl })
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: opts.systemPrompt,
    messages: [{ role: 'user', content: opts.userPrompt }],
  })

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')

  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    },
  }
}
