import type { WorkflowTool, ToolInjectionContext } from './types'
import { resolveToolScript } from './resolve-script'

export const inspectLogsTool: WorkflowTool = {
  id: 'inspect-logs',
  name: '运行日志检查',
  description: '始终注入，允许 Agent 查看 code-agent 的引擎日志和 Provider 调用日志以定位问题。',
  injectionRule: '始终注入',
  usage: 'inspect-logs.sh --tmpdir <path> <command>\n命令: list | tail <log-name> [lines] | search <log-name> "<keyword>" [limit]',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveToolScript('inspect-logs', 'run.sh')
  },

  getPromptSection(_ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const tmpdir = process.env.TMPDIR || '/tmp'
    const base = `bash "${scriptAbsPath}" --tmpdir "${tmpdir}"`

    return `## 运行日志检查工具

当你需要排查 code-agent 自身的运行问题时，可以通过 shell 执行以下命令查看日志：

1. **列出所有日志文件**：
\`\`\`bash
${base} list
\`\`\`

2. **查看日志末尾**（默认 50 行）：
\`\`\`bash
${base} tail <log-name> [lines]
\`\`\`

3. **在日志中搜索关键词**：
\`\`\`bash
${base} search <log-name> "关键词" [limit]
\`\`\`

日志文件命名约定 \`code-agent-*.log\`，常见文件：
- \`code-agent-engine.log\` — 工作流引擎日志
- \`code-agent-provider.log\` — Agent 调用日志`
  },
}
