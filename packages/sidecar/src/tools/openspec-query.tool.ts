import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolInjectionContext, WorkflowTool } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

    return `## OpenSpec 查询工具

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

### 参数
| 参数 | 说明 |
|------|------|
| \`--change-dir\` | openspec 变更目录路径 |
| \`--change-id\` | 变更 ID |`
  },
}
