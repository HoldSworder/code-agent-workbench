/**
 * 飞书云文档 URL 解析。
 * 支持 wiki / docx / doc / sheets 四种类型。
 */

const LARK_URL_PATTERNS = [
  { type: 'wiki' as const, regex: /\/wiki\/([\w-]+)/ },
  { type: 'docx' as const, regex: /\/docx\/([\w-]+)/ },
  { type: 'doc' as const, regex: /\/doc\/([\w-]+)/ },
  { type: 'sheets' as const, regex: /\/sheets\/([\w-]+)/ },
]

export type LarkDocType = 'wiki' | 'docx' | 'doc' | 'sheets'

export interface ParsedLarkUrl {
  type: LarkDocType
  token: string
}

/**
 * 从飞书 URL 中提取文档类型与 token。
 * 例：https://feishu.cn/wiki/ABC123 → { type: 'wiki', token: 'ABC123' }
 */
export function parseLarkDocUrl(url: string): ParsedLarkUrl | null {
  for (const { type, regex } of LARK_URL_PATTERNS) {
    const match = url.match(regex)
    if (match?.[1]) return { type, token: match[1] }
  }
  return null
}
