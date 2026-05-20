import type Anthropic from '@anthropic-ai/sdk'
import { callAnthropic } from './anthropic'

export interface GenerateBranchSlugOptions {
  /** 已有 Anthropic 客户端，复用以避免重复读取环境变量。 */
  client?: Anthropic
  apiKey?: string
  baseUrl?: string
  model?: string
  /** 整体超时（毫秒），默认 8000。 */
  timeoutMs?: number
}

export const BRANCH_SLUG_SYSTEM_PROMPT = `You translate Chinese or mixed-language software requirement titles into concise English git branch slugs.

Hard rules:
- Output ONLY the slug, no prefix, no quotes, no explanation, no trailing punctuation.
- 3 to 6 lowercase words joined by hyphens (kebab-case).
- ASCII letters and digits only; no underscores; no slashes; no leading/trailing hyphens.
- Convey the core action and object (verb-noun if possible), drop filler words.
- Do not include the literal word "feature" or any branch prefix.
- If the input is already an English phrase, just normalize it to kebab-case.`

const SLUG_RE = /[a-z0-9][a-z0-9-]*[a-z0-9]/

/**
 * 将需求标题翻译/规范化为可作为 git 分支后缀的 kebab-case 英文 slug。
 *
 * 返回值不含 `feature/` 前缀。调用方按需拼接。
 *
 * 失败语义：网络/超时/格式不合法 → 抛错。上层决定是否兜底。
 */
export async function generateBranchSlug(title: string, opts: GenerateBranchSlugOptions = {}): Promise<string> {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('generateBranchSlug: title 为空')

  const timeoutMs = opts.timeoutMs ?? 8000
  const callPromise = callAnthropic({
    systemPrompt: BRANCH_SLUG_SYSTEM_PROMPT,
    userPrompt: trimmed,
    client: opts.client,
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
    maxTokens: 64,
  })

  const result = await Promise.race([
    callPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`generateBranchSlug: LLM 调用超时 (${timeoutMs}ms)`)), timeoutMs),
    ),
  ])

  return normalizeSlug(result.text)
}

/**
 * 清洗 LLM 输出：去引号/空白/前缀 → 转 kebab-case → 校验合法。
 * 导出供测试与上层 fallback 复用。
 */
export function normalizeSlug(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^["'`]+|["'`]+$/g, '')
  s = s.replace(/^feature[\/-]/, '')
  s = s.split('\n')[0] ?? ''
  s = s.replace(/[\s_]+/g, '-')
  s = s.replace(/[^a-z0-9-]/g, '')
  s = s.replace(/-{2,}/g, '-')
  s = s.replace(/^-+|-+$/g, '')

  const m = s.match(SLUG_RE)
  if (!m) throw new Error(`generateBranchSlug: 输出无法归一化为合法 slug: ${JSON.stringify(raw)}`)
  let slug = m[0]
  if (slug.length > 60) {
    const cut = slug.slice(0, 60).replace(/-+[^-]*$/, '')
    slug = cut || slug.slice(0, 60)
  }
  return slug
}
