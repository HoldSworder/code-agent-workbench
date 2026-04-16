import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'repo-info', 'run.sh')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'repo-info', 'run.sh')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const repoInfoTool: WorkflowTool = {
  id: 'repo-info',
  name: '仓库信息查询',
  description: '始终注入，允许 Agent 查询系统中已配置的仓库列表、别名、路径及关联任务。',
  injectionRule: '始终注入',
  usage: 'bash repo-info.sh --db <path> <command>\n命令: list | get <id|name|alias> | tasks <id|name|alias>',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const base = `bash "${scriptAbsPath}" --db "${ctx.dbPath}"`

    return `## 仓库信息查询工具

查询系统中已配置的仓库列表、别名、路径及关联任务。

### 列出所有仓库
\`\`\`bash
${base} list
\`\`\`

### 按 id/名称/别名查询单个仓库
\`\`\`bash
${base} get <id_or_name_or_alias>
\`\`\`

### 查看某仓库的所有任务
\`\`\`bash
${base} tasks <id_or_name_or_alias>
\`\`\`

### 使用策略

1. 需要了解系统管理了哪些仓库时用 \`list\`
2. 需要某个仓库的具体路径、默认分支等配置时用 \`get\`
3. 需要查看某仓库下所有进行中的任务时用 \`tasks\``
  },
}
