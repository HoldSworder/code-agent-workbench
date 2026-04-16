import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Resolve absolute path to project-root `tools/task-progress.sh`.
 *   dev:  packages/sidecar/src/tools/  -> 4 levels up -> <root>/tools/
 *   prod: packages/sidecar/dist/       -> 3 levels up -> <root>/tools/
 */
function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'task-progress', 'run.sh')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'task-progress', 'run.sh')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const taskProgressTool: WorkflowTool = {
  id: 'task-progress',
  name: '任务进度查询',
  description: '始终注入，允许 Agent 查询当前任务的工作流全局状态、各阶段进度和提交记录。',
  injectionRule: '始终注入',
  usage: 'task-progress.sh --db <path> --task <id> <command>\n命令: overview | phases | commits',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const base = `bash "${scriptAbsPath}" --db "${ctx.dbPath}" --task "${ctx.repoTaskId}"`

    return `## 任务进度查询工具

当你需要了解当前任务的全局工作流状态时，可以通过 shell 执行以下命令：

1. **查看任务概况**（当前所在 stage/phase、状态、分支、路径等）：
\`\`\`bash
${base} overview
\`\`\`

2. **查看所有已激活阶段的详情**（各阶段的消息数、commit、最近一次 agent 运行状态）：
\`\`\`bash
${base} phases
\`\`\`

3. **查看各阶段关联的 commit**：
\`\`\`bash
${base} commits
\`\`\`

使用策略：先用 \`overview\` 了解任务当前位置和状态，再用 \`phases\` 查看各阶段的进展详情。`
  },
}
