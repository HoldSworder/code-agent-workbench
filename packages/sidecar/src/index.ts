import { createInterface } from 'node:readline'
import { resolve, dirname, join } from 'node:path'
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { getDb } from './db/connection'
import { RpcServer } from './rpc/server'
import { registerMethods } from './rpc/methods'
import { registerReviewMethods } from './rpc/review-methods'
import { registerFeishuProjectMethods } from './rpc/feishu-project-methods'
import { listSessionsForRepo } from './transcript/reader'
import { WorkflowEngine } from './workflow/engine'
import { Orchestrator } from './orchestrator/orchestrator'
import { parseTeamConfig } from './orchestrator/team-parser'
import { registerOrchestratorMethods, registerTeamConfigMethods } from './orchestrator/rpc'
import {
  createCursorSdkProvider,
  loadAgentRuntimeFromSettings,
} from './providers/factory'
import { applyGlobalProxy } from './providers/proxy'
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
    return readdirSync(dir) as string[]
  }
  catch {
    return []
  }
}

const settingsRepo = new SettingsRepository(db)

// 仅用于 recoverMcpBackups 清理历史遗留的 .cursor/mcp.json 备份（旧 CLI 模式产物）。
const currentCliType = () => 'cursor-cli'

/**
 * 同步代理设置到当前进程。
 *
 * 1. env 变量：供 fork 出去的子进程（如 consult 的 cursor-cli）继承。
 * 2. undici 全局 dispatcher：env 对 native fetch（@cursor/sdk）无效，必须显式设置，
 *    否则父进程内的 SDK 调用（models.list / review / consult）会一直直连。
 */
function syncProcessProxyEnv(proxyUrl: string | undefined): void {
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
  applyGlobalProxy(proxyUrl)
}

// 启动即应用一次，覆盖首个 run 之前发生的父进程 SDK 调用（如模型列表）。
syncProcessProxyEnv(
  settingsRepo.get('proxy.enabled') === 'true' ? (settingsRepo.get('proxy.url') ?? undefined) : undefined,
)

const engine = new WorkflowEngine({
  db,
  dbPath,
  workflowYaml,
  cliType: currentCliType(),
  resolveProvider: (_providerType, options) => {
    // 全面 SDK 化后所有 provider 统一走 CursorSdkProvider；
    // workflow.yaml 中的 provider 字段（external-cli / codex / api）已不再区分后端，
    // 仅保留 modelOverride / resumeSessionId(cursor agentId) 语义。
    const runtime = loadAgentRuntimeFromSettings(settingsRepo)
    syncProcessProxyEnv(settingsRepo.get('proxy.enabled') === 'true' ? (settingsRepo.get('proxy.url') ?? undefined) : undefined)
    return createCursorSdkProvider({
      runtime,
      modelOverride: options?.modelOverride,
      resumeAgentId: options?.resumeSessionId,
    })
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

    orchestrator = new Orchestrator({
      db,
      teamConfig,
      teamYamlPath,
      repoPath,
      defaultBranch,
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
  const model = settingsRepo.get('consult.model') ?? settingsRepo.get('agent.model') ?? undefined
  const cursorApiKey = settingsRepo.get('agent.cursorApiKey') ?? process.env.CURSOR_API_KEY ?? ''
  const port = Number(settingsRepo.get('consult.port')) || 3100
  return { cursorApiKey, model, port }
}

const consultStaticDir = resolve(projectRoot, 'apps/consult/dist')
const consultServer = new ConsultServer({ db, config: buildConsultConfig(), staticDir: consultStaticDir })

const rpcServer = new RpcServer()
registerMethods(rpcServer, db, engine, workflowPath, consultServer, buildConsultConfig, workflowsDir, dbPath)
registerReviewMethods(rpcServer, db)
registerFeishuProjectMethods(rpcServer)

// 配置 RPC 始终可用（即使 team.yaml 不存在也能创建）
registerTeamConfigMethods(rpcServer, teamYamlPath, () => orchestrator, () => {
  const enabled = settingsRepo.get('proxy.enabled') === 'true'
  return enabled ? (settingsRepo.get('proxy.url') ?? undefined) : undefined
})

if (orchestrator)
  registerOrchestratorMethods(rpcServer, orchestrator)

// 暴露项目根目录与对应 Cursor Agent 历史会话（供桌面端 Cursor CLI 页面使用）
rpcServer.register('system.projectRoot', async () => ({ path: projectRoot }))
rpcServer.register(
  'system.sessions',
  async ({ limit, offset }: { limit?: number, offset?: number }) => {
    const all = listSessionsForRepo(projectRoot)
    const total = all.length
    const offsetN = Math.max(0, Math.floor(offset ?? 0))
    if (limit == null || limit <= 0)
      return { items: all, total }
    const cap = Math.min(Math.max(1, limit), 200)
    return { items: all.slice(offsetN, offsetN + cap), total }
  },
)

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const response = await rpcServer.handle(line)
  process.stdout.write(`${response}\n`)
})

process.stderr.write('sidecar: ready\n')
