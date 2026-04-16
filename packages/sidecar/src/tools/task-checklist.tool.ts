import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'task-checklist', 'run.mjs')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'task-checklist', 'run.mjs')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

function resolveTasksPath(ctx: ToolInjectionContext): string {
  if (ctx.openspecPath) {
    return resolve(ctx.openspecPath, 'tasks.md')
  }
  return resolve(ctx.worktreePath, 'openspec', 'changes', '*', 'tasks.md')
}

export const taskChecklistTool: WorkflowTool = {
  id: 'task-checklist',
  name: '任务清单管理',
  description: '始终注入，允许 Agent 管理 tasks.md 中的 checkbox 状态（勾选/取消勾选）并查询进度。',
  injectionRule: '始终注入',
  usage: 'node run.mjs --file <tasks_md_path> <command> [target]\n命令: list | check | uncheck | progress',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const tasksPath = resolveTasksPath(ctx)
    const base = `node "${scriptAbsPath}" --file "${tasksPath}"`

    return `## 任务清单工具

管理 tasks.md 文件中的任务 checkbox 状态。

### 查看任务列表与进度
\`\`\`bash
${base} list
\`\`\`

### 勾选完成的任务
\`\`\`bash
${base} check T1
\`\`\`

### 取消勾选
\`\`\`bash
${base} uncheck T1
\`\`\`

### 仅查看进度统计
\`\`\`bash
${base} progress
\`\`\`

### 参数说明

| 参数 | 说明 |
|------|------|
| \`--file\` | tasks.md 文件的绝对路径（必填） |

### Target 格式

| 格式 | 说明 |
|------|------|
| \`T1\`, \`T2\` | 从内容提取的任务 id |
| \`L3\`, \`3\` | 按行号定位 |

### 使用策略

1. 开始开发前用 \`list\` 查看当前任务状态
2. 每完成一个任务后用 \`check\` 勾选
3. 用 \`progress\` 快速查看整体进度`
  },
}
