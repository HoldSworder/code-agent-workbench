/**
 * MCP HTTP/SSE 响应解析。
 *
 * MCP server 既可能返回纯 JSON 响应，也可能返回 SSE 流（content-type: text/event-stream），
 * 这里两种格式都尝试，最后兜底逐行 JSON 解析。
 */

export interface JsonRpcResponse {
  jsonrpc?: string
  id?: string | number | null
  result?: any
  error?: {
    code?: number
    message?: string
  }
}

function parseSsePayloads(text: string): unknown[] {
  const payloads: unknown[] = []
  const dataLines: string[] = []

  const flush = (): void => {
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n').trim()
    dataLines.length = 0
    if (!payload) return
    payloads.push(JSON.parse(payload))
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()
  return payloads
}

/**
 * 解析 MCP JSON-RPC 响应：
 * 1. 优先按 JSON 整体解析；
 * 2. 失败则按 SSE event-stream 解析；
 * 3. 仍失败则逐行 JSON 解析。
 */
export function parseMcpResponseText(text: string): JsonRpcResponse {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Empty MCP response body')

  try {
    return JSON.parse(trimmed) as JsonRpcResponse
  }
  catch { /* fall through */ }

  try {
    const payloads = parseSsePayloads(trimmed)
    const match = payloads.find((payload): payload is JsonRpcResponse =>
      Boolean(payload && typeof payload === 'object' && ('result' in payload || 'error' in payload)),
    )
    if (match) return match
  }
  catch { /* fall through */ }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('event:') || line.startsWith(':')) continue
    try {
      return JSON.parse(line) as JsonRpcResponse
    }
    catch { /* try next */ }
  }

  throw new Error('Unable to parse MCP response payload')
}
