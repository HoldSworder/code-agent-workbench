/**
 * 统一规范化未知错误为字符串消息。
 * 优先使用 `Error.message`，否则 `String(err)`，对 null/undefined 返回 'Unknown error'。
 */
export function errorMessage(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return String(err)
  }
  catch {
    return 'Unknown error'
  }
}
