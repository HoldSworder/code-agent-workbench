import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'ui-element', 'run.mjs')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'ui-element', 'run.mjs')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

export const uiElementTool: WorkflowTool = {
  id: 'ui-element',
  name: '动态 UI 元素',
  description: '始终注入，允许 Agent 在对话窗口中渲染交互式 UI 元素（选择项、表单、按钮），用户操作后 Agent 可读取结果。',
  injectionRule: '始终注入',
  usage: 'node run.mjs --dir <path> emit --type select|form|actions --schema \'<JSON>\'\nnode run.mjs --dir <path> read-response --id <id>',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const base = `node "${scriptAbsPath}" --dir "${ctx.worktreePath}"`

    return `## 动态 UI 工具

当你需要让用户做选择、填写表单或确认操作时，使用此工具在对话窗口中渲染交互式 UI。
用户会看到渲染好的卡片/表单/按钮，提交后你可以读取结果继续工作。

### 1. 发送选择项（用户从选项中选一个）

\`\`\`bash
${base} emit --type select --schema '{"title":"选择部署环境","options":[{"value":"staging","label":"测试环境","description":"用于 QA 验证"},{"value":"production","label":"生产环境","description":"正式上线"}]}'
\`\`\`

### 2. 发送表单（用户填写多个字段）

\`\`\`bash
${base} emit --type form --schema '{"title":"配置参数","fields":[{"name":"branch","type":"text","label":"分支名","required":true,"placeholder":"main"},{"name":"env","type":"select","label":"环境","options":[{"value":"staging","label":"测试"},{"value":"prod","label":"生产"}]},{"name":"notify","type":"checkbox","label":"部署后通知","default":true}]}'
\`\`\`

表单字段类型: \`text\`、\`textarea\`、\`select\`、\`checkbox\`、\`radio\`、\`number\`

### 3. 发送操作按钮（用户点击其中一个）

\`\`\`bash
${base} emit --type actions --schema '{"title":"请确认操作","buttons":[{"value":"approve","label":"批准合并","style":"primary"},{"value":"reject","label":"驳回","style":"danger"},{"value":"skip","label":"跳过","style":"secondary"}]}'
\`\`\`

按钮样式: \`primary\`（主操作）、\`secondary\`（次要）、\`danger\`（危险/删除）

### 4. 读取用户响应

\`\`\`bash
${base} read-response --id <element-id>
\`\`\`

返回 \`{"id":"...","status":"responded","response":{...}}\` 或 \`{"id":"...","status":"pending","response":null}\`

### 5. 列出所有 UI 元素

\`\`\`bash
${base} list
\`\`\`

### 使用策略（重要 — 必须遵守）

**你必须在以下场景使用此工具，禁止用纯文本列选项让用户手动输入：**

1. **方案/选项选择** — 需要用户从多个方案中选一个时 → emit select
2. **参数收集** — 需要用户提供多个配置参数/信息时 → emit form
3. **关键操作确认** — 需要用户确认危险操作或决策时 → emit actions
4. **验证结果决策** — 呈现测试/验证结果并让用户决定下一步时 → emit actions
5. **信息补充** — 阶段执行前需要用户补充 URL、凭证、环境信息时 → emit form

**工作流程：**

1. 调用 \`emit\` 后立即输出 \`<<PENDING_INPUT>>\` 等待用户操作
2. 下次对话时通过 \`read-response\` 获取用户选择，基于结果继续工作
3. 一个阶段内可 emit 多个 UI 元素
4. emit 返回的 \`id\` 用于后续 \`read-response\` 读取`
  },
}
