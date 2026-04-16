import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'phase-signal', 'run.mjs')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'phase-signal', 'run.mjs')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const phaseSignalTool: WorkflowTool = {
  id: 'phase-signal',
  name: '阶段进度信号',
  description: '始终注入，允许 Agent 报告当前阶段的步骤级进度，控制用户界面是否显示推进按钮。',
  injectionRule: '始终注入',
  usage: 'node phase-signal.mjs --dir <path> --phase <id> [--status ...] [--step ...] <command>\n命令: update | read | clear',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const base = `node "${scriptAbsPath}" --dir "${ctx.worktreePath}" --phase "${ctx.currentPhaseId}"`

    return `## 阶段进度信号工具

你可以在执行过程中通过此工具报告当前步骤进度。这直接决定了用户界面是否显示"进入下一阶段"按钮：
- 状态为 \`in_progress\` 或 \`blocked\` 时，用户**看不到**推进按钮，只能继续与你对话
- 状态为 \`ready\` 时，用户**可以**选择确认并推进到下一阶段

### 报告进度（每当进入新步骤或状态变化时调用）

\`\`\`bash
${base} --status in_progress --step "1/4" --step-name "探索项目上下文" update
\`\`\`

### 标记本阶段产出就绪

\`\`\`bash
${base} --status ready --step "4/4" --step-name "全部产出已生成" update
\`\`\`

### 查看当前信号

\`\`\`bash
${base} read
\`\`\`

### 参数说明

| 参数 | 说明 |
|------|------|
| \`--status\` | \`in_progress\`（默认）、\`ready\`、\`blocked\` |
| \`--step\` | 步骤进度，如 \`"2/7"\` |
| \`--step-name\` | 步骤名称，如 \`"逐个澄清需求"\` |
| \`--reason\` | 状态原因，如 \`"等待用户回答澄清问题"\` |

### 使用策略

1. **进入每个主要步骤时**调用 update 报告进度（step + step-name）
2. **需要用户输入时**保持 \`in_progress\` 状态并附带 reason
3. **所有产出物生成完毕后**调用 update 将状态改为 \`ready\`
4. 无需在每次对话轮次都调用，仅在步骤切换或状态变化时调用`
  },
}
