import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowTool, ToolInjectionContext } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function resolveScriptPath(): string {
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'tools', 'gate-status', 'run.mjs')
  const prodPath = resolve(__dirname, '..', '..', '..', 'tools', 'gate-status', 'run.mjs')
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (existsSync(devPath)) return devPath
    if (existsSync(prodPath)) return prodPath
  }
  catch { /* fallback */ }
  return devPath
}

function encodeGates(defs: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(defs)).toString('base64')
}

export const gateStatusTool: WorkflowTool = {
  id: 'gate-status',
  name: '门禁状态查询',
  description: '始终注入，允许 Agent 查询 gate 条件的实时满足状态，了解当前阶段及后续阶段的门禁是否通过。',
  injectionRule: '始终注入',
  usage: 'node gate-status.mjs --dir <path> --openspec <path> --gates <base64> <command>\n命令: check <gate_name> | list',

  shouldInject(_ctx: ToolInjectionContext): boolean {
    return true
  },

  resolveScript(_ctx: ToolInjectionContext): string | null {
    return resolveScriptPath()
  },

  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string {
    const gates = ctx.gateDefinitions ?? {}
    const gatesB64 = encodeGates(gates)
    const openspec = ctx.openspecPath ?? ''
    const base = `node "${scriptAbsPath}" --dir "${ctx.worktreePath}" --openspec "${openspec}" --gates "${gatesB64}"`

    const phaseGates = ctx.currentPhaseGates
    const relevantGates: string[] = []
    if (phaseGates?.entryGate) relevantGates.push(phaseGates.entryGate)
    if (phaseGates?.completionCheck) relevantGates.push(phaseGates.completionCheck)
    if (phaseGates?.stageGate) relevantGates.push(phaseGates.stageGate)

    const gateHint = relevantGates.length > 0
      ? `\n\n当前阶段相关的 gate：${relevantGates.map(g => `\`${g}\``).join('、')}`
      : ''

    return `## 门禁状态查询工具

你可以在执行过程中查询 gate 条件是否满足，了解前置产出是否就绪、当前阶段完成条件是否达成。

### 检查指定 gate

\`\`\`bash
${base} check <gate_name>
\`\`\`

返回该 gate 的详细检查结果（每项 check 的通过状态）。

### 列出所有 gate 状态

\`\`\`bash
${base} list
\`\`\`

返回所有已定义 gate 的名称、描述及通过状态。${gateHint}

### 使用策略

1. **进入新阶段前**检查 entry_gate 是否满足，确认前置产出就绪
2. **阶段工作完成后**检查 completion_check，确认产出符合要求
3. **需要了解整体进展时**用 list 查看所有门禁状态`
  },
}
