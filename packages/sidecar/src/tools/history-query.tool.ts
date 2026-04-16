import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Resolve absolute path to project-root `tools/query-history.sh`.
 * Layout (from this file's perspective):
 *   dev:  packages/sidecar/src/tools/  -> 4 levels up -> <root>/tools/
 *   prod: packages/sidecar/dist/       -> 3 levels up -> <root>/tools/
 */
function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'history-query', 'run.sh')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'history-query', 'run.sh')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const historyQueryTool: WorkflowTool = {
  id: 'history-query',
  name: '历史对话查询',
  description: '当同一任务的其他阶段存在对话记录时自动注入，允许 Agent 渐进式搜索之前阶段的问答内容。',
  injectionRule: '当同一任务的其他阶段存在对话记录时注入',
  usage: 'query-history.sh --db <path> --task <id> --phase <id> <command>\n命令: list | get <phase-id> [limit] [offset] | search "<keyword>" [limit]',

  shouldInject(ctx: ToolInjectionContext): boolean {
    const row = ctx.db.prepare(`
      SELECT COUNT(*) AS cnt FROM conversation_messages
      WHERE repo_task_id = ? AND phase_id != ? AND role IN ('user', 'assistant')
    `).get(ctx.repoTaskId, ctx.currentPhaseId) as { cnt: number } | undefined
    return (row?.cnt ?? 0) > 0
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const base = `bash "${scriptAbsPath}" --db "${ctx.dbPath}" --task "${ctx.repoTaskId}" --phase "${ctx.currentPhaseId}"`

    return `## 历史对话查询工具

当你需要了解之前阶段的对话上下文时，可以通过 shell 执行以下命令渐进式地获取信息：

1. **列出所有有对话记录的阶段**（先用此命令了解全局概况）：
\`\`\`bash
${base} list
\`\`\`

2. **获取指定阶段的对话详情**（按需分页，避免一次获取过多）：
\`\`\`bash
${base} get <phase-id> [limit] [offset]
\`\`\`

3. **按关键词搜索所有阶段的对话**：
\`\`\`bash
${base} search "关键词" [limit]
\`\`\`

使用策略：先用 \`list\` 获取概览，根据摘要判断哪些阶段与当前任务相关，再用 \`get\` 或 \`search\` 获取具体内容。每次只获取少量消息（默认 10 条），需要更多时再增加 offset。`
  },
}
