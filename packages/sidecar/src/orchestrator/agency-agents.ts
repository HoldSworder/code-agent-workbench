const REPO = 'msitarzewski/agency-agents'
const BRANCH = 'main'
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`
const API_BASE = `https://api.github.com/repos/${REPO}`

const EXCLUDED_FILES = new Set([
  'README.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING_zh-CN.md',
  'LICENSE',
])

const EXCLUDED_DIRS = new Set([
  '.github',
  'examples',
  'integrations',
  'scripts',
])

// ── Types ──

export interface AgentCatalogItem {
  path: string
  category: string
  filename: string
}

export interface AgentCatalog {
  categories: Record<string, AgentCatalogItem[]>
}

export interface AgentPromptDetail {
  name: string
  description: string
  emoji: string
  prompt: string
}

// ── Cache ──

let catalogCache: { data: AgentCatalog, ts: number } | null = null
const CACHE_TTL = 10 * 60 * 1000

// ── Proxy-aware fetch ──

async function proxyFetch(url: string, proxyUrl?: string): Promise<Response> {
  if (proxyUrl) {
    try {
      const { ProxyAgent, fetch: uFetch } = await import('undici')
      const dispatcher = new ProxyAgent(proxyUrl)
      return uFetch(url, { dispatcher }) as unknown as Response
    }
    catch {
      // undici not available, fall through to global fetch
    }
  }
  return fetch(url)
}

// ── Public API ──

export async function fetchAgencyCatalog(proxyUrl?: string): Promise<AgentCatalog> {
  if (catalogCache && Date.now() - catalogCache.ts < CACHE_TTL)
    return catalogCache.data

  const res = await proxyFetch(`${API_BASE}/git/trees/${BRANCH}?recursive=1`, proxyUrl)
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)

  const json = await res.json() as { tree: Array<{ path: string, type: string }> }

  const categories: Record<string, AgentCatalogItem[]> = {}

  for (const node of json.tree) {
    if (node.type !== 'blob' || !node.path.endsWith('.md'))
      continue

    const parts = node.path.split('/')
    if (parts.length < 2)
      continue

    const topDir = parts[0]
    if (EXCLUDED_DIRS.has(topDir))
      continue

    const filename = parts[parts.length - 1]
    if (EXCLUDED_FILES.has(filename))
      continue

    const category = topDir

    if (!categories[category])
      categories[category] = []

    categories[category].push({
      path: node.path,
      category,
      filename,
    })
  }

  for (const items of Object.values(categories)) {
    items.sort((a, b) => a.filename.localeCompare(b.filename))
  }

  const data: AgentCatalog = { categories }
  catalogCache = { data, ts: Date.now() }
  return data
}

export async function fetchAgentPrompt(path: string, proxyUrl?: string): Promise<AgentPromptDetail> {
  const res = await proxyFetch(`${RAW_BASE}/${path}`, proxyUrl)
  if (!res.ok)
    throw new Error(`Failed to fetch agent: ${res.status} ${res.statusText}`)

  const text = await res.text()
  return parseFrontmatter(text)
}

// ── Helpers ──

function parseFrontmatter(content: string): AgentPromptDetail {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)

  if (!fmMatch) {
    return { name: '', description: '', emoji: '', prompt: content.trim() }
  }

  const fm = fmMatch[1]
  const body = fmMatch[2].trim()

  const name = extractField(fm, 'name') ?? ''
  const description = extractField(fm, 'description') ?? ''
  const emoji = extractField(fm, 'emoji') ?? ''

  return { name, description, emoji, prompt: body }
}

function extractField(fm: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm')
  const m = fm.match(re)
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined
}
