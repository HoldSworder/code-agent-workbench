import { errorMessage } from '../util/error'
import { runLarkCli, runLarkCliJson, type RunLarkCliOptions } from './cli'
import { parseLarkDocUrl, type ParsedLarkUrl } from './url'

export interface CreateDocOptions {
  title: string
  /** Markdown 内容；通过 `--markdown` 传入。 */
  content: string
  /** 父目录 token；不传则放云空间根目录。 */
  folderToken?: string | null
  cli?: RunLarkCliOptions
}

export interface CreateDocResult {
  token: string
  url: string
}

/**
 * 通过 `lark-cli docs +create` 新建一篇飞书云文档。
 * lark-cli 真实 flag：--title / --markdown / --folder-token。
 * 返回 JSON 字段：doc_id / doc_url。
 */
export async function createDoc(opts: CreateDocOptions): Promise<CreateDocResult> {
  const args = ['docs', '+create', '--title', opts.title, '--markdown', opts.content]
  if (opts.folderToken) args.push('--folder-token', opts.folderToken)
  const data = await runLarkCliJson<Record<string, unknown> & { data?: Record<string, unknown> }>(args, opts.cli)
  const token = (data?.doc_id ?? data?.data?.doc_id) as string | undefined
  if (!token) throw new Error(`docs +create 未返回 doc_id: ${JSON.stringify(data).slice(0, 200)}`)
  const url = (data?.doc_url ?? data?.data?.doc_url) as string | undefined
  return { token, url: url ?? `https://feishu.cn/docx/${token}` }
}

async function resolveWikiToken(wikiToken: string, cli?: RunLarkCliOptions): Promise<string | null> {
  try {
    const data = await runLarkCliJson<Record<string, any>>(
      ['wiki', 'spaces', 'get_node', '--params', JSON.stringify({ token: wikiToken }), '--format', 'json'],
      cli,
    )
    const node = data?.data?.node ?? data?.node
    return node?.obj_token ?? null
  }
  catch {
    return null
  }
}

/** wiki 链接需先 get_node 得到 obj_token，其它类型直接返回 token。 */
async function ensureDocxToken(input: string, cli?: RunLarkCliOptions): Promise<string> {
  const parsed: ParsedLarkUrl | null = parseLarkDocUrl(input)
  if (parsed?.type === 'wiki') {
    const resolved = await resolveWikiToken(parsed.token, cli)
    if (!resolved) throw new Error(`无法解析 wiki token: ${parsed.token}`)
    return resolved
  }
  if (parsed) return parsed.token
  return input
}

/**
 * 通过 `lark-cli docs +fetch` 获取文档 markdown。
 * 真实返回字段：markdown / title / has_more（不是 content）。
 */
export async function fetchDoc(tokenOrUrl: string, cli?: RunLarkCliOptions): Promise<string> {
  const token = await ensureDocxToken(tokenOrUrl, cli)
  const data = await runLarkCliJson<Record<string, any>>(
    ['docs', '+fetch', '--doc', token, '--format', 'json'],
    cli,
  )
  return data?.markdown ?? data?.data?.markdown ?? ''
}

/** docs +update --mode overwrite，整篇覆盖。 */
export async function overwriteDoc(tokenOrUrl: string, content: string, cli?: RunLarkCliOptions): Promise<void> {
  const token = await ensureDocxToken(tokenOrUrl, cli)
  await runLarkCli(['docs', '+update', '--doc', token, '--mode', 'overwrite', '--markdown', content], cli)
}

/** docs +update --mode append，文档末尾追加。 */
export async function appendDoc(tokenOrUrl: string, content: string, cli?: RunLarkCliOptions): Promise<void> {
  const token = await ensureDocxToken(tokenOrUrl, cli)
  await runLarkCli(['docs', '+update', '--doc', token, '--mode', 'append', '--markdown', content], cli)
}

export interface FetchLarkDocResult {
  content: string
  error?: string
}

/**
 * 综合方法：解析 URL → wiki/docx/doc 自动 resolve → fetch markdown。
 * 失败时不抛错，统一返回 `{ content: '', error }`，便于上层透传到 UI。
 */
export async function fetchLarkDocContent(docUrl: string, cli?: RunLarkCliOptions): Promise<FetchLarkDocResult> {
  const parsed = parseLarkDocUrl(docUrl)
  if (!parsed) return { content: '', error: `无法解析飞书文档 URL: ${docUrl}` }
  if (parsed.type === 'sheets') return { content: '', error: 'sheets 类型暂不支持 markdown 抓取' }

  try {
    const markdown = await fetchDoc(docUrl, cli)
    if (!markdown) return { content: '', error: '文档内容为空' }
    return { content: markdown }
  }
  catch (err) {
    return { content: '', error: `lark-cli 获取文档失败: ${errorMessage(err)}` }
  }
}
