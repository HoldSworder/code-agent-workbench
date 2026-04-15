import { createInterface } from 'node:readline'
import { resolve, dirname, join } from 'node:path'
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { getDb } from './db/connection'
import { RpcServer } from './rpc/server'
import { registerMethods } from './rpc/methods'
import { WorkflowEngine } from './workflow/engine'
import { Orchestrator } from './orchestrator/orchestrator'
import { parseTeamConfig } from './orchestrator/team-parser'
import { registerOrchestratorMethods, registerTeamConfigMethods } from './orchestrator/rpc'
import { ExternalCliProvider } from './providers/cli.provider'
import { ApiProvider } from './providers/api.provider'
import { SettingsRepository } from './db/repositories/settings.repo'
import { ConsultServer } from './consult/server'
import type { ConsultConfig } from './consult/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function parseArg(name: string): string | undefined {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined
}

const projectRoot = parseArg('project-root') ?? resolve(__dirname, '../../..')
const workflowsDir = resolve(projectRoot, 'workflows')

const dbPath = process.env.DB_PATH
  ?? parseArg('db-path')
  ?? (parseArg('project-root')
    ? resolve(projectRoot, 'data', 'code-agent.db')
    : resolve(__dirname, '..', 'code-agent.db'))
const workflowPath = process.env.WORKFLOW_PATH ?? resolve(projectRoot, 'workflow.yaml')

try { mkdirSync(dirname(dbPath), { recursive: true }) } catch {}

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

      // 嵌套在子目录中的插件（两层和三层嵌套）
      // 两层: cache/{vendor}/{pack}/skills/{name}/SKILL.md
      // 三层: cache/{vendor}/{pack}/{hash}/skills/{name}/SKILL.md
      const nestedEntries = readdirSafe(join(pluginCacheDir, entry))
      for (const nested of nestedEntries) {
        const nestedSkill = join(pluginCacheDir, entry, nested, 'skills', name, 'SKILL.md')
        if (existsSync(nestedSkill))
          return readFileSync(nestedSkill, 'utf-8')

        const hashEntries = readdirSafe(join(pluginCacheDir, entry, nested))
        for (const hash of hashEntries) {
          const hashSkill = join(pluginCacheDir, entry, nested, hash, 'skills', name, 'SKILL.md')
          if (existsSync(hashSkill))
            return readFileSync(hashSkill, 'utf-8')
        }
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
    const globalProvider = settingsRepo.get('agent.provider') ?? 'cursor-cli'
    const globalModel = settingsRepo.get('agent.model') ?? undefined
    const binaryPath = settingsRepo.get('agent.binaryPath') ?? undefined
    const proxyEnabled = settingsRepo.get('proxy.enabled') === 'true'
    const proxyUrl = proxyEnabled ? (settingsRepo.get('proxy.url') ?? undefined) : undefined

    const provider = options?.agentOverride ?? globalProvider
    const model = options?.modelOverride ?? globalModel

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
      case 'codex':
        return new ExternalCliProvider({
          type: 'codex',
          model,
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

// ── Orchestrator (multi-agent, independent from WorkflowEngine) ──

const teamYamlPath = process.env.TEAM_YAML_PATH ?? resolve(projectRoot, 'workflows', 'orchestrator', 'team.yaml')
let orchestrator: Orchestrator | null = null

try {
  if (existsSync(teamYamlPath)) {
    const teamYaml = readFileSync(teamYamlPath, 'utf-8')
    const teamConfig = parseTeamConfig(teamYaml, dirname(teamYamlPath))
    const repoPath = settingsRepo.get('repo.path') ?? process.cwd()
    const defaultBranch = settingsRepo.get('repo.defaultBranch') ?? 'main'

    const orchProxyEnabled = settingsRepo.get('proxy.enabled') === 'true'
    const orchProxyUrl = orchProxyEnabled ? (settingsRepo.get('proxy.url') ?? undefined) : undefined
    const orchSniPatch = (() => {
      if (!orchProxyUrl || !existsSync(sniPatchPath)) return undefined
      const socks5 = parseSocks5Config(orchProxyUrl)
      if (!socks5) return undefined
      return { scriptPath: sniPatchPath, socks5Host: socks5.host, socks5Port: socks5.port }
    })()

    orchestrator = new Orchestrator({
      db,
      teamConfig,
      teamYamlPath,
      repoPath,
      defaultBranch,
      sniProxyPatch: orchSniPatch,
      onEvent: (event, data) => {
        process.stderr.write(`orchestrator: ${event} ${JSON.stringify(data ?? {})}\n`)
      },
    })
  }
}
catch (err) {
  process.stderr.write(`orchestrator: failed to load team.yaml: ${err}\n`)
}

// ── Consultation server (read-only WebUI for LAN access) ──

function buildConsultConfig(): ConsultConfig {
  const provider = (settingsRepo.get('consult.provider') ?? settingsRepo.get('agent.provider') ?? 'cursor-cli') as ConsultConfig['provider']
  const model = settingsRepo.get('consult.model') ?? settingsRepo.get('agent.model') ?? undefined
  const binaryPath = settingsRepo.get('consult.binaryPath') ?? settingsRepo.get('agent.binaryPath') ?? undefined
  const port = Number(settingsRepo.get('consult.port')) || 3100
  const proxyEnabled = settingsRepo.get('proxy.enabled') === 'true'
  const proxyUrl = proxyEnabled ? (settingsRepo.get('proxy.url') ?? undefined) : undefined

  const sniProxyPatch = (() => {
    if (!proxyUrl || !existsSync(sniPatchPath)) return undefined
    const socks5 = parseSocks5Config(proxyUrl)
    if (!socks5) return undefined
    return { scriptPath: sniPatchPath, socks5Host: socks5.host, socks5Port: socks5.port }
  })()

  return { provider, model, binaryPath, port, proxyUrl, sniProxyPatch }
}

const consultStaticDir = resolve(projectRoot, 'apps/consult/dist')
const consultServer = new ConsultServer({ db, config: buildConsultConfig(), staticDir: consultStaticDir })

const rpcServer = new RpcServer()
registerMethods(rpcServer, db, engine, workflowPath, consultServer, buildConsultConfig, workflowsDir)

// 配置 RPC 始终可用（即使 team.yaml 不存在也能创建）
registerTeamConfigMethods(rpcServer, teamYamlPath, () => orchestrator, () => {
  const enabled = settingsRepo.get('proxy.enabled') === 'true'
  return enabled ? (settingsRepo.get('proxy.url') ?? undefined) : undefined
})

if (orchestrator)
  registerOrchestratorMethods(rpcServer, orchestrator)

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const response = await rpcServer.handle(line)
  process.stdout.write(`${response}\n`)
})

process.stderr.write('sidecar: ready\n')
