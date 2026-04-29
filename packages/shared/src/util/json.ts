/**
 * 安全 JSON 解析：失败时返回 null，永不抛错。
 */
export function tryParseJson<T = unknown>(text: string): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  }
  catch {
    return null
  }
}

/**
 * 移除 Markdown 代码围栏（``` 或 ```json）后再解析的文本。
 * 兼容 LLM 输出有时把 JSON 包在 fence 里的场景。
 */
export function stripJsonFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
}

/**
 * 同时尝试 fence 移除 + 解析。
 */
export function tryParseJsonLoose<T = unknown>(text: string): T | null {
  return tryParseJson<T>(stripJsonFences(text))
}
