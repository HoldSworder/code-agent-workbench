import type { WorkflowTool, ToolInjectionContext } from './types'
import { resolveToolScript } from './resolve-script'

export const advancePhaseTool: WorkflowTool = {
  id: 'advance-phase',
  name: '阶段推进',
  description: '由 Agent 自驱推进工作流阶段。写入 advance-request.json 信号文件后 engine 校验 gate，过则进入下一阶段或挂起等用户确认；不过则反馈错误让 Agent 修正。',
  injectionRule: '始终注入（单会话工作流模式下）',
  usage: 'node run.mjs --dir <path> --phase <id> --mode <next|target|pending_input|terminal> [--target <id>] [--note ...] request',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveToolScript('advance-phase', 'run.mjs')
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const base = `node "${scriptAbsPath}" --dir "${ctx.worktreePath}" --phase "${ctx.currentPhaseId}"`

    return `## 阶段推进工具（advance-phase）

**这是你推进工作流的唯一正式入口**。当你判断当前阶段的全部产出已经就绪、需要进入下一阶段时，必须调用此工具。Engine 会读取请求文件，校验 gate / confirm_files 是否满足，决定是直接进入下一阶段、挂起等用户确认，还是把错误反馈给你让你修正。

### 推进到下一个默认阶段

\`\`\`bash
${base} --mode next --note "已生成 proposal.md 与 specs/" request
\`\`\`

### 推进到指定阶段（激活 optional / 跳过）

\`\`\`bash
${base} --mode target --target integration --note "后端 spec 已到，开始联调" request
\`\`\`

### 当前阶段产出未就绪，主动挂起等用户输入

\`\`\`bash
${base} --mode pending_input --note "需要用户提供测试账号" request
\`\`\`

### 整任务终结（仅 archive-deploy 阶段使用）

\`\`\`bash
${base} --mode terminal --note "已归档发布" request
\`\`\`

### 行为约定

1. 调用本工具后立即结束本轮回复，**不要再继续输出代码或继续做事**。
2. 如果 engine 反馈 gate 校验失败（你会在下一轮 user message 里看到错误信息），按提示修正后再调用一次。
3. 不要重复调用，每轮回复至多调用一次。
4. 当本阶段配置了 \`requires_confirm: true\` 时，engine 会把状态改为 \`waiting_confirm\`，等用户点击 UI 确认后才会把"继续"消息回传给你；这是正常流程，不是错误。`
  },
}
