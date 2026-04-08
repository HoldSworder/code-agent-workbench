import { createInterface } from 'node:readline'
import { resolve, dirname, join } from 'node:path'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { getDb } from './db/connection'
import { RpcServer } from './rpc/server'
import { registerMethods } from './rpc/methods'
import { WorkflowEngine } from './workflow/engine'
import { ExternalCliProvider } from './providers/cli.provider'
import { ApiProvider } from './providers/api.provider'
import { SettingsRepository } from './db/repositories/settings.repo'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = resolve(__dirname, '../../..')
const workflowsDir = resolve(projectRoot, 'workflows')

const dbPath = process.env.DB_PATH ?? resolve(__dirname, '..', 'code-agent.db')
const workflowPath = process.env.WORKFLOW_PATH ?? resolve(process.cwd(), 'workflow.yaml')

const db = getDb(dbPath)

let workflowYaml: string
try {
  workflowYaml = readFileSync(workflowPath, 'utf-8')
}
catch {
  workflowYaml = readFileSync(resolve(projectRoot, 'workflow.yaml'), 'utf-8')
}

/**
 * 解析技能内容。支持两种格式：
 * 1. 本地文件路径：如 "skills/design.md"
 * 2. 技能包标识符：如 "superpowers:brainstorming"、"fe-specflow:design-to-opsx"
 *
 * 技能包搜索路径优先级：
 *   ~/.cursor/skills/{pack}/skills/{name}/SKILL.md
 *   ~/.cursor/plugins/cache/{entry}/{pack}/skills/{name}/SKILL.md
 *   ~/.claude/skills/{pack}/skills/{name}/SKILL.md
 */
function resolveSkillContent(skillPath: string): string {
  // 本地文件路径（如 "skills/design.md"）
  if (!skillPath.includes(':')) {
    const candidates = [
      resolve(skillPath),
      resolve(projectRoot, skillPath),
    ]
    if (existsSync(workflowsDir)) {
      for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        candidates.push(resolve(workflowsDir, entry.name, skillPath))
      }
    }
    for (const p of candidates) {
      if (existsSync(p))
        return readFileSync(p, 'utf-8')
    }
    return ''
  }

  // 技能包标识符（如 "superpowers:brainstorming"）
  const [pack, name] = skillPath.split(':')
  const home = homedir()

  const searchPaths = [
    join(home, '.cursor', 'skills', pack, 'skills', name, 'SKILL.md'),
    join(home, '.claude', 'skills', pack, 'skills', name, 'SKILL.md'),
  ]

  for (const p of searchPaths) {
    if (existsSync(p))
      return readFileSync(p, 'utf-8')
  }

  // 搜索 Cursor 插件缓存目录
  const pluginCacheDir = join(home, '.cursor', 'plugins', 'cache')
  if (existsSync(pluginCacheDir)) {
    const cacheEntries = readdirSafe(pluginCacheDir)
    for (const entry of cacheEntries) {
      const skillFile = join(pluginCacheDir, entry, pack, 'skills', name, 'SKILL.md')
      if (existsSync(skillFile))
        return readFileSync(skillFile, 'utf-8')

      // fe-specflow 等嵌套在子目录中的插件
      const nestedEntries = readdirSafe(join(pluginCacheDir, entry))
      for (const nested of nestedEntries) {
        const nestedSkill = join(pluginCacheDir, entry, nested, 'skills', name, 'SKILL.md')
        if (existsSync(nestedSkill))
          return readFileSync(nestedSkill, 'utf-8')
      }
    }
  }

  return ''
}

function readdirSafe(dir: string): string[] {
  try {
    const { readdirSync } = require('node:fs')
    return readdirSync(dir) as string[]
  }
  catch {
    return []
  }
}

const settingsRepo = new SettingsRepository(db)

const sniPatchPath = resolve(projectRoot, 'scripts', 'agent-socks5-patch.cjs')

function parseSocks5Config(proxyUrl: string): { host: string, port: number } | null {
  try {
    const url = new URL(proxyUrl)
    return { host: url.hostname || '127.0.0.1', port: Number(url.port) || 7890 }
  }
  catch {
    const match = proxyUrl.match(/:(\d+)\s*$/)
    return match ? { host: '127.0.0.1', port: Number(match[1]) } : null
  }
}

const currentCliType = () => settingsRepo.get('agent.provider') ?? 'cursor-cli'

const engine = new WorkflowEngine({
  db,
  workflowYaml,
  cliType: currentCliType(),
  resolveProvider: (providerType, options) => {
    const provider = settingsRepo.get('agent.provider') ?? 'cursor-cli'
    const model = settingsRepo.get('agent.model') ?? undefined
    const binaryPath = settingsRepo.get('agent.binaryPath') ?? undefined
    const proxyEnabled = settingsRepo.get('proxy.enabled') === 'true'
    const proxyUrl = proxyEnabled ? (settingsRepo.get('proxy.url') ?? undefined) : undefined

    if (proxyUrl) {
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.ALL_PROXY = proxyUrl
    }
    else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.ALL_PROXY
    }

    const sniProxyPatch = (() => {
      if (!proxyUrl || !existsSync(sniPatchPath)) return undefined
      const socks5 = parseSocks5Config(proxyUrl)
      if (!socks5) return undefined
      return { scriptPath: sniPatchPath, socks5Host: socks5.host, socks5Port: socks5.port }
    })()

    switch (providerType) {
      case 'external-cli':
        return new ExternalCliProvider({
          type: provider as 'cursor-cli' | 'claude-code' | 'codex',
          model,
          binaryPath,
          resumeSessionId: options?.resumeSessionId,
          proxyUrl,
          sniProxyPatch,
        })
      case 'api':
        return new ApiProvider({
          type: 'anthropic',
          apiKey: settingsRepo.get('agent.apiKey') ?? process.env.ANTHROPIC_API_KEY ?? '',
          model: model ?? process.env.MODEL ?? 'claude-sonnet-4-20250514',
        })
      default:
        throw new Error(`Unknown provider: ${providerType}`)
    }
  },
  resolveSkillContent,
})

if (existsSync(workflowsDir)) {
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const wfYamlPath = resolve(workflowsDir, entry.name, 'workflow.yaml')
    if (existsSync(wfYamlPath)) {
      try {
        const yaml = readFileSync(wfYamlPath, 'utf-8')
        engine.addWorkflow(entry.name, yaml)
      }
      catch (err) {
        process.stderr.write(`sidecar: failed to load workflow ${entry.name}: ${err}\n`)
      }
    }
  }
}

engine.recoverMcpBackups()

const rpcServer = new RpcServer()
registerMethods(rpcServer, db, engine, workflowPath)

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const response = await rpcServer.handle(line)
  process.stdout.write(`${response}\n`)
})

process.stderr.write('sidecar: ready\n')
