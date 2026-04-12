import { execFileSync } from 'node:child_process'

const LARK_URL_PATTERNS = [
  { type: 'wiki', regex: /\/wiki\/(\w+)/ },
  { type: 'docx', regex: /\/docx\/(\w+)/ },
  { type: 'doc', regex: /\/doc\/(\w+)/ },
  { type: 'sheets', regex: /\/sheets\/(\w+)/ },
] as const

interface ParsedLarkUrl {
  type: 'wiki' | 'docx' | 'doc' | 'sheets'
  token: string
}

function parseLarkUrl(url: string): ParsedLarkUrl | null {
  for (const { type, regex } of LARK_URL_PATTERNS) {
    const match = url.match(regex)
    if (match?.[1]) return { type, token: match[1] }
  }
  return null
}

function execLarkCli(args: string[]): string {
  return execFileSync('lark-cli', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env },
  }).trim()
}

/**
 * Wiki 链接需要先获取真实的 obj_token 再 fetch。
 * Returns the resolved doc URL (e.g. docx token) for wiki nodes.
 */
function resolveWikiToken(wikiToken: string): string | null {
  try {
    const raw = execLarkCli([
      'wiki', 'spaces', 'get_node',
      '--params', JSON.stringify({ token: wikiToken }),
      '--format', 'json',
    ])
    const data = JSON.parse(raw)
    const node = data?.data?.node ?? data?.node
    if (!node?.obj_token) return null
    return node.obj_token
  }
  catch {
    return null
  }
}

/**
 * 使用 lark-cli 获取飞书文档的 Markdown 内容。
 * 自动处理 wiki 链接（先 resolve node → 再 fetch docx）。
 */
export async function fetchLarkDocContent(docUrl: string): Promise<{ content: string, error?: string }> {
  const parsed = parseLarkUrl(docUrl)
  if (!parsed) {
    return { content: '', error: `无法解析飞书文档 URL: ${docUrl}` }
  }

  try {
    let fetchToken = parsed.token

    if (parsed.type === 'wiki') {
      const resolved = resolveWikiToken(parsed.token)
      if (!resolved) {
        return { content: '', error: `Wiki 节点 ${parsed.token} 解析失败，无法获取 obj_token` }
      }
      fetchToken = resolved
    }

    const raw = execLarkCli([
      'docs', '+fetch',
      '--doc', fetchToken,
      '--format', 'json',
    ])

    const data = JSON.parse(raw)
    const markdown = data?.data?.content ?? data?.content ?? ''

    if (!markdown) {
      return { content: '', error: '文档内容为空' }
    }

    return { content: markdown }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: '', error: `lark-cli 获取文档失败: ${msg}` }
  }
}
