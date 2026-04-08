import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  existsSync,
  statSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'

export type ManageableEnv = 'claude' | 'codex' | 'cursor'
export type SkillType = 'skill' | 'command'

export interface PluginMeta {
  name: string
  displayName?: string
  version?: string
  description?: string
  author?: string
}

export interface EnvInstallation {
  installed: boolean
  path?: string
  isSymlink?: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  type: SkillType
  dirName: string
  realDir: string
  skillMdPath: string
  plugin?: PluginMeta
  envs: Record<ManageableEnv, EnvInstallation>
}

const HOME = homedir()

const ENV_DIRS: { env: ManageableEnv, dir: string, label: string }[] = [
  { env: 'claude', dir: join(HOME, '.claude', 'skills'), label: 'Claude Code' },
  { env: 'codex', dir: join(HOME, '.codex', 'skills'), label: 'Codex' },
  { env: 'cursor', dir: join(HOME, '.cursor', 'skills'), label: 'Cursor' },
]

export const ENV_LABELS: Record<ManageableEnv, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

// ── Helpers ──

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) }
  catch { return [] }
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const yaml = match[1]
  const result: Record<string, string> = {}
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)/)
    if (!kv) continue
    result[kv[1]] = kv[2].replace(/^["'>-]\s*/, '').replace(/["']$/, '').trim()
  }
  if (!result.description) {
    const block = yaml.match(/description:\s*>-?\s*\n([\s\S]*?)(?=\n\w|\n---|\Z)/)
    if (block)
      result.description = block[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ')
  }
  return result
}

function readPluginJson(hashDir: string): PluginMeta | undefined {
  for (const metaDir of ['.cursor-plugin', '.claude-plugin', '.codex-plugin']) {
    const p = join(hashDir, metaDir, 'plugin.json')
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      return {
        name: raw.name ?? '',
        displayName: raw.displayName,
        version: raw.version,
        description: raw.description,
        author: typeof raw.author === 'string' ? raw.author : raw.author?.name,
      }
    }
    catch { /* ignore */ }
  }
  return undefined
}

function safeRealpath(p: string): string | null {
  try { return realpathSync(p) }
  catch { return null }
}

// ── Env Status ──

function buildEnvStatus(dirName: string): Record<ManageableEnv, EnvInstallation> {
  const result = {} as Record<ManageableEnv, EnvInstallation>
  for (const { env, dir } of ENV_DIRS) {
    const entryPath = join(dir, dirName)
    if (!existsSync(entryPath)) {
      result[env] = { installed: false }
      continue
    }
    try {
      const isSymlink = lstatSync(entryPath).isSymbolicLink()
      result[env] = { installed: true, path: entryPath, isSymlink }
    }
    catch {
      result[env] = { installed: false }
    }
  }
  return result
}

const EMPTY_ENV_STATUS: Record<ManageableEnv, EnvInstallation> = {
  claude: { installed: false },
  codex: { installed: false },
  cursor: { installed: false },
}

// ── Raw Skill Entry ──

interface RawSkill {
  name: string
  description: string
  type: SkillType
  dirName: string
  realDir: string
  skillMdPath: string
  plugin?: PluginMeta
  nativeEnvs: Set<ManageableEnv>
}

// ── Directory Scanner ──

function scanSkillDir(dir: string): RawSkill[] {
  const results: RawSkill[] = []
  for (const entry of safeReaddir(dir)) {
    if (entry.startsWith('.')) continue
    const entryPath = join(dir, entry)
    const realDir = safeRealpath(entryPath)
    if (!realDir) continue
    try { if (!statSync(realDir).isDirectory()) continue }
    catch { continue }

    const skillMd = join(realDir, 'SKILL.md')
    if (!existsSync(skillMd)) continue

    let fm: Record<string, string> = {}
    try { fm = parseFrontmatter(readFileSync(skillMd, 'utf-8')) }
    catch { /* unreadable */ }

    results.push({
      name: fm.name || entry,
      description: fm.description || '',
      type: 'skill',
      dirName: entry,
      realDir,
      skillMdPath: skillMd,
      nativeEnvs: new Set(),
    })
  }
  return results
}

// ── Plugin Cache Scanner ──

function scanPluginCache(cacheDir: string): RawSkill[] {
  const results: RawSkill[] = []

  for (const publisher of safeReaddir(cacheDir)) {
    if (publisher.startsWith('.')) continue
    for (const pack of safeReaddir(join(cacheDir, publisher))) {
      if (pack.startsWith('.')) continue
      for (const hash of safeReaddir(join(cacheDir, publisher, pack))) {
        if (hash.startsWith('.')) continue
        const hashDir = join(cacheDir, publisher, pack, hash)
        try { if (!statSync(hashDir).isDirectory()) continue }
        catch { continue }

        const pluginMeta = readPluginJson(hashDir)

        const skillsDir = join(hashDir, 'skills')
        if (existsSync(skillsDir)) {
          for (const skillName of safeReaddir(skillsDir)) {
            if (skillName.startsWith('.')) continue
            const skillDir = join(skillsDir, skillName)
            const skillMd = join(skillDir, 'SKILL.md')
            if (!existsSync(skillMd)) continue

            const realDir = safeRealpath(skillDir)
            if (!realDir) continue

            let fm: Record<string, string> = {}
            try { fm = parseFrontmatter(readFileSync(skillMd, 'utf-8')) }
            catch { /* unreadable */ }

            results.push({
              name: fm.name || skillName,
              description: fm.description || '',
              type: 'skill',
              dirName: skillName,
              realDir,
              skillMdPath: safeRealpath(skillMd) ?? skillMd,
              plugin: pluginMeta,
              nativeEnvs: new Set(),
            })
          }
        }

        const cmdsDir = join(hashDir, 'commands')
        if (existsSync(cmdsDir)) {
          for (const file of safeReaddir(cmdsDir)) {
            if (!file.endsWith('.md')) continue
            const filePath = join(cmdsDir, file)
            try { if (!statSync(filePath).isFile()) continue }
            catch { continue }

            const cmdName = file.replace(/\.md$/, '')
            let fm: Record<string, string> = {}
            try { fm = parseFrontmatter(readFileSync(filePath, 'utf-8')) }
            catch { /* unreadable */ }

            results.push({
              name: fm.name || cmdName,
              description: fm.description || '',
              type: 'command',
              dirName: cmdName,
              realDir: safeRealpath(filePath) ?? filePath,
              skillMdPath: safeRealpath(filePath) ?? filePath,
              plugin: pluginMeta,
              nativeEnvs: new Set(),
            })
          }
        }
      }
    }
  }

  return results
}

// ── Main Scan ──

export function scanAllSkills(): SkillInfo[] {
  const rawSkills: RawSkill[] = []

  for (const { dir } of ENV_DIRS) {
    if (existsSync(dir)) rawSkills.push(...scanSkillDir(dir))
  }

  const codexSystem = join(HOME, '.codex', 'skills', '.system')
  if (existsSync(codexSystem)) {
    for (const s of scanSkillDir(codexSystem)) {
      s.nativeEnvs.add('codex')
      rawSkills.push(s)
    }
  }

  const cursorBuiltin = join(HOME, '.cursor', 'skills-cursor')
  if (existsSync(cursorBuiltin)) {
    for (const s of scanSkillDir(cursorBuiltin)) {
      s.nativeEnvs.add('cursor')
      rawSkills.push(s)
    }
  }

  const pluginCache = join(HOME, '.cursor', 'plugins', 'cache')
  if (existsSync(pluginCache)) {
    for (const s of scanPluginCache(pluginCache)) {
      s.nativeEnvs.add('cursor')
      rawSkills.push(s)
    }
  }

  const byDirName = new Map<string, RawSkill>()
  for (const skill of rawSkills) {
    const existing = byDirName.get(skill.dirName)
    if (!existing) {
      byDirName.set(skill.dirName, skill)
    }
    else {
      if (!existing.description && skill.description) existing.description = skill.description
      if (!existing.plugin && skill.plugin) existing.plugin = skill.plugin
      for (const env of skill.nativeEnvs) existing.nativeEnvs.add(env)
    }
  }

  return [...byDirName.values()]
    .map((skill) => {
      const envs = skill.type === 'command'
        ? { ...EMPTY_ENV_STATUS }
        : buildEnvStatus(skill.dirName)

      for (const env of skill.nativeEnvs) {
        if (!envs[env].installed)
          envs[env] = { installed: true, path: skill.realDir }
      }

      return {
        id: skill.dirName,
        name: skill.name,
        description: skill.description,
        type: skill.type,
        dirName: skill.dirName,
        realDir: skill.realDir,
        skillMdPath: skill.skillMdPath,
        plugin: skill.plugin,
        envs,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── Enable / Disable ──

export function enableSkill(dirName: string, realDir: string, env: ManageableEnv): void {
  const envConfig = ENV_DIRS.find(e => e.env === env)
  if (!envConfig) throw new Error(`Unknown environment: ${env}`)

  if (!existsSync(envConfig.dir))
    mkdirSync(envConfig.dir, { recursive: true })

  const targetPath = join(envConfig.dir, dirName)
  if (existsSync(targetPath))
    throw new Error(`Already exists: ${targetPath}`)

  symlinkSync(realDir, targetPath)
}

export function disableSkill(dirName: string, env: ManageableEnv): void {
  const envConfig = ENV_DIRS.find(e => e.env === env)
  if (!envConfig) throw new Error(`Unknown environment: ${env}`)

  const targetPath = join(envConfig.dir, dirName)
  if (!existsSync(targetPath)) return

  if (lstatSync(targetPath).isSymbolicLink()) {
    unlinkSync(targetPath)
  }
  else {
    throw new Error(`${targetPath} is not a symlink. Manual removal required.`)
  }
}

// ── Content Reader ──

export function readSkillContent(skillPath: string): string {
  try {
    return existsSync(skillPath) ? readFileSync(skillPath, 'utf-8') : ''
  }
  catch {
    return ''
  }
}
