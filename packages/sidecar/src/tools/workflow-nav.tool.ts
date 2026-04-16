import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'workflow-nav', 'run.mjs')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'workflow-nav', 'run.mjs')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const workflowNavTool: WorkflowTool = {
  id: 'workflow-nav',
  name: '工作流导航',
  description: '查询工作流的全局结构、当前位置和可用路径，让 Agent 对工作流全貌不再"盲"。',
  injectionRule: '始终注入（当工作流结构上下文存在时）',
  usage: 'node run.mjs --config <base64> --current-stage <id> --current-phase <id> <command>\n命令: current | map | next',

  shouldInject(ctx: ToolInjectionContext): boolean {
    return !!(ctx.workflowStages?.length && ctx.currentStageId)
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    if (!ctx.workflowStages || !ctx.currentStageId) return ''

    const b64 = Buffer.from(JSON.stringify(ctx.workflowStages)).toString('base64')
    const base = `node "${scriptAbsPath}" --config "${b64}" --current-stage "${ctx.currentStageId}" --current-phase "${ctx.currentPhaseId}"`

    return `## 工作流导航工具

查询工作流的全局结构、当前位置和可用路径。

### 查看当前位置
\`\`\`bash
${base} current
\`\`\`

### 查看完整工作流地图
\`\`\`bash
${base} map
\`\`\`

### 查看下一步可选路径
\`\`\`bash
${base} next
\`\`\`

### 使用策略

1. **进入新阶段时**先用 \`current\` 确认当前位置
2. **不确定工作流全貌时**用 \`map\` 查看完整地图
3. **准备推进时**用 \`next\` 查看下一步可选路径和前置条件`
  },
}
