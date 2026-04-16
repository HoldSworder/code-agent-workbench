import { execSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolInjectionContext, WorkflowTool } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let _cliVersion: string | false | null = null

/**
 * Detects whether `openspec` CLI is available on PATH.
 * Returns the version string if installed, `false` otherwise.
 * Result is cached for the process lifetime.
 */
function detectOpenspecCli(): string | false {
  if (_cliVersion !== null) return _cliVersion
  try {
    const ver = execSync('openspec --version', { stdio: 'pipe', timeout: 3000 }).toString().trim()
    _cliVersion = ver || 'unknown'
  }
  catch {
    _cliVersion = false
  }
  return _cliVersion
}

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'openspec-query', 'run.mjs')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'openspec-query', 'run.mjs')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const openspecQueryTool: WorkflowTool = {
  id: 'openspec-query',
  name: 'OpenSpec 查询',
  description: '查询 OpenSpec 变更目录的状态、获取文档模板、执行校验。封装 openspec CLI 的查询类命令。',
  injectionRule: '始终注入',
  usage: 'node run.mjs --change-dir <path> --change-id <id> <command>\n命令: status | instructions <type> | validate',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const openspecPath = ctx.openspecPath
    if (!openspecPath) {
      return ''
    }
    const changeId = basename(openspecPath)
    const base = `node "${scriptAbsPath}" --change-dir "${openspecPath}" --change-id "${changeId}"`

    const cliVersion = detectOpenspecCli()
    const cliStatus = cliVersion
      ? `**OpenSpec CLI: 已安装 (v${cliVersion})**  — 可直接使用 \`openspec\` 命令进行变更管理。`
      : `**OpenSpec CLI: 未安装** — 仅查询工具可用，写操作需手动创建目录结构。`

    const cliCommands = cliVersion
      ? `### OpenSpec CLI 写操作（已安装可用）

创建新变更目录：
\`\`\`bash
openspec new change "${changeId}"
\`\`\`

恢复进行中的变更：
\`\`\`bash
openspec change continue "${changeId}"
\`\`\`

完整校验（优先使用）：
\`\`\`bash
openspec validate "${changeId}"
\`\`\``
      : `### 降级写操作（CLI 未安装）

手动创建变更目录结构：
\`\`\`bash
mkdir -p ${openspecPath}/specs/<capability-name>/
\`\`\``

    return `## OpenSpec 查询工具

${cliStatus}

查询 OpenSpec 变更目录的状态、获取文档模板、执行校验。

### 查询变更状态
\`\`\`bash
${base} status
\`\`\`

### 获取 instructions 模板
\`\`\`bash
${base} instructions proposal
${base} instructions specs
${base} instructions tasks
\`\`\`

### 执行校验
\`\`\`bash
${base} validate
\`\`\`

${cliCommands}

### 参数
| 参数 | 说明 |
|------|------|
| \`--change-dir\` | openspec 变更目录路径 |
| \`--change-id\` | 变更 ID |`
  },
}
