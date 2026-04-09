import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import https from 'node:https'
import http from 'node:http'

export interface SkillStoreRegistry {
  id: string
  name: string
  apiBase: string
}

export interface RemoteSkillItem {
  slug: string
  displayName: string
  summary: string | null
  tags: string[]
  stats: {
    downloads: number
    installs: number
    versions: number
    stars: number
  }
  highlighted: boolean
  createdAt: number
  updatedAt: number
  latestVersion: {
    version: string
    createdAt: number
    changelog: string
  } | null
  /** skills.sh: GitHub "owner/repo" that hosts this skill */
  source?: string
}

export interface RemoteSkillFile {
  path: string
  size: number
  storageKey: string
  sha256: string
  contentType: string
}

export interface RemoteSkillOwner {
  handle: string
  displayName: string
  image: string
}

export interface RemoteSkillDetail {
  skill: RemoteSkillItem
  latestVersion: {
    version: string
    createdAt: number
    changelog: string
    files: RemoteSkillFile[]
  } | null
  owner: RemoteSkillOwner
  isStarred: boolean
  readme?: string
}

export interface RemoteSkillListResult {
  items: RemoteSkillItem[]
  nextCursor: string | null
}

const HOME = homedir()
const STORE_INSTALL_DIR = join(HOME, '.claude', 'skills')

const SKILLS_SH_API = 'https://skills.sh'

function httpGet(url: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const client = parsed.protocol === 'https:' ? https : http
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      timeout: 15_000,
      headers: {
        'User-Agent': 'CodeAgent/1.0',
        ...headers,
      },
    }
    const req = client.get(opts, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, headers).then(resolve, reject)
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)) })
  })
}

// ── skills.sh adapter ──

interface SkillsShRawItem {
  source: string
  skillId: string
  name: string
  installs: number
}

function parseSkillsShRSC(body: string): SkillsShRawItem[] {
  const regex = /\{"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]+)","installs":(\d+)\}/g
  const results: SkillsShRawItem[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(body)) !== null) {
    results.push({ source: m[1], skillId: m[2], name: m[3], installs: Number(m[4]) })
  }
  return results
}

function skillsShItemToRemote(raw: SkillsShRawItem): RemoteSkillItem {
  return {
    slug: raw.skillId,
    displayName: raw.name,
    summary: `From ${raw.source}`,
    tags: [],
    stats: { downloads: 0, installs: raw.installs, versions: 0, stars: 0 },
    highlighted: false,
    createdAt: 0,
    updatedAt: 0,
    latestVersion: null,
    source: raw.source,
  }
}

async function listSkillsShSkills(): Promise<RemoteSkillListResult> {
  const body = await httpGet(SKILLS_SH_API, { RSC: '1' })
  const raw = parseSkillsShRSC(body)
  const seen = new Set<string>()
  const deduped = raw.filter((item) => {
    const key = `${item.source}/${item.skillId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { items: deduped.map(skillsShItemToRemote), nextCursor: null }
}

interface GitHubContent {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
  download_url: string | null
}

async function getSkillsShDetail(slug: string, source: string): Promise<RemoteSkillDetail> {
  const url = `https://api.github.com/repos/${source}/contents/skills/${encodeURIComponent(slug)}`
  const body = await httpGet(url, { Accept: 'application/vnd.github.v3+json' })
  const entries = JSON.parse(body) as GitHubContent[]

  const files: RemoteSkillFile[] = entries
    .filter(e => e.type === 'file')
    .map(e => ({
      path: e.name,
      size: e.size,
      storageKey: '',
      sha256: '',
      contentType: e.name.endsWith('.md') ? 'text/markdown' : 'application/octet-stream',
    }))

  const item: RemoteSkillItem = {
    slug,
    displayName: slug,
    summary: `From ${source}`,
    tags: [],
    stats: { downloads: 0, installs: 0, versions: 0, stars: 0 },
    highlighted: false,
    createdAt: 0,
    updatedAt: 0,
    latestVersion: null,
    source,
  }

  let readme = ''
  const skillMdEntry = entries.find(e => e.name === 'SKILL.md')
  if (skillMdEntry?.download_url) {
    try { readme = await httpGet(skillMdEntry.download_url) } catch {}
  }

  return {
    skill: item,
    latestVersion: {
      version: 'latest',
      createdAt: 0,
      changelog: '',
      files,
    },
    owner: { handle: source.split('/')[0], displayName: source, image: '' },
    isStarred: false,
    readme,
  }
}

async function installSkillsShSkill(
  slug: string,
  source: string,
): Promise<{ installed: boolean, dirName: string, path: string, fileCount: number }> {
  const url = `https://api.github.com/repos/${source}/contents/skills/${encodeURIComponent(slug)}`
  const body = await httpGet(url, { Accept: 'application/vnd.github.v3+json' })
  const entries = JSON.parse(body) as GitHubContent[]
  const files = entries.filter(e => e.type === 'file' && e.download_url)

  if (!files.length)
    throw new Error(`Skill "${slug}" from ${source} has no files`)

  const targetDir = join(STORE_INSTALL_DIR, slug)
  if (existsSync(targetDir))
    rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  let downloaded = 0
  for (const file of files) {
    const content = await httpGet(file.download_url!)
    const filePath = join(targetDir, file.name)
    writeFileSync(filePath, content, 'utf-8')
    downloaded++
  }

  return { installed: true, dirName: slug, path: targetDir, fileCount: downloaded }
}

// ── OnionHub adapter (original) ──

async function listOnionHubSkills(apiBase: string, cursor?: string): Promise<RemoteSkillListResult> {
  let url = `${apiBase}/api/v1/skills`
  if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`
  const body = await httpGet(url)
  return JSON.parse(body) as RemoteSkillListResult
}

async function getOnionHubDetail(apiBase: string, slug: string): Promise<RemoteSkillDetail> {
  const url = `${apiBase}/api/v1/skills/${encodeURIComponent(slug)}`
  const body = await httpGet(url)
  return JSON.parse(body) as RemoteSkillDetail
}

async function downloadOnionHubFile(apiBase: string, slug: string, filePath: string, version: string): Promise<string> {
  const url = `${apiBase}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(filePath)}&version=${encodeURIComponent(version)}`
  return httpGet(url)
}

async function installOnionHubSkill(
  apiBase: string,
  slug: string,
  version?: string,
): Promise<{ installed: boolean, dirName: string, path: string, fileCount: number }> {
  const detail = await getOnionHubDetail(apiBase, slug)
  const ver = version ?? detail.latestVersion?.version ?? 'latest'
  const files = detail.latestVersion?.files ?? []

  if (!files.length)
    throw new Error(`Skill "${slug}" has no files in version ${ver}`)

  const targetDir = join(STORE_INSTALL_DIR, slug)
  if (existsSync(targetDir))
    rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })

  let downloaded = 0
  for (const file of files) {
    const content = await downloadOnionHubFile(apiBase, slug, file.path, ver)
    const filePath = join(targetDir, file.path)
    const fileDir = dirname(filePath)
    if (!existsSync(fileDir))
      mkdirSync(fileDir, { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
    downloaded++
  }

  return { installed: true, dirName: slug, path: targetDir, fileCount: downloaded }
}

// ── Public API (dispatches by registry) ──

function isSkillsSh(apiBase: string): boolean {
  return apiBase.includes('skills.sh')
}

interface SkillsShSearchResult {
  query: string
  searchType: string
  skills: SkillsShRawItem[]
  count: number
  duration_ms: number
}

export async function searchRemoteSkills(
  apiBase: string,
  query: string,
): Promise<RemoteSkillListResult> {
  if (!isSkillsSh(apiBase)) {
    return listOnionHubSkills(apiBase)
  }
  const url = `https://skills.sh/api/search?q=${encodeURIComponent(query)}`
  const body = await httpGet(url)
  const data = JSON.parse(body) as SkillsShSearchResult
  const seen = new Set<string>()
  const deduped = data.skills.filter((item) => {
    const key = `${item.source}/${item.skillId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { items: deduped.map(skillsShItemToRemote), nextCursor: null }
}

export async function listRemoteSkills(apiBase: string, cursor?: string): Promise<RemoteSkillListResult> {
  if (isSkillsSh(apiBase)) return listSkillsShSkills()
  return listOnionHubSkills(apiBase, cursor)
}

export async function getRemoteSkillDetail(apiBase: string, slug: string, source?: string): Promise<RemoteSkillDetail> {
  if (isSkillsSh(apiBase)) {
    if (!source) throw new Error('source (GitHub owner/repo) is required for skills.sh')
    return getSkillsShDetail(slug, source)
  }
  return getOnionHubDetail(apiBase, slug)
}

export async function installRemoteSkill(
  apiBase: string,
  slug: string,
  version?: string,
  source?: string,
): Promise<{ installed: boolean, dirName: string, path: string, fileCount: number }> {
  if (isSkillsSh(apiBase)) {
    if (!source) throw new Error('source (GitHub owner/repo) is required for skills.sh')
    return installSkillsShSkill(slug, source)
  }
  return installOnionHubSkill(apiBase, slug, version)
}

export function uninstallRemoteSkill(slug: string): boolean {
  const targetDir = join(STORE_INSTALL_DIR, slug)
  if (!existsSync(targetDir)) return false
  rmSync(targetDir, { recursive: true, force: true })
  return true
}

export function getInstalledSlugs(): string[] {
  if (!existsSync(STORE_INSTALL_DIR)) return []
  try {
    return readdirSync(STORE_INSTALL_DIR).filter((entry) => {
      if (entry.startsWith('.')) return false
      return existsSync(join(STORE_INSTALL_DIR, entry, 'SKILL.md'))
    })
  }
  catch {
    return []
  }
}
