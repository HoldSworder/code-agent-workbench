import type { PhaseContext } from './types'

/**
 * 根据 phase 配置动态生成「阶段完成状态标记」提示词。
 *
 * - requires_confirm=true → Agent 完成产出后必须标记 PENDING_INPUT 等待用户确认
 * - 有 completion_check（gates 中含 ✅） → Agent 必须确保产出物存在后才能标记 PHASE_COMPLETE
 * - 默认 → 基础标记协议
 */
export function buildSignalPrompt(context: PhaseContext): string {
  const lines: string[] = []

  lines.push('## 阶段完成状态标记（必须遵守）')
  lines.push('')
  lines.push('你必须在回复的最末尾添加以下标记之一来声明本次执行的完成状态：')
  lines.push('')
  lines.push('- `<<PHASE_COMPLETE>>` — 你已完成本阶段的所有产出（文件已写入、命令已执行等）')
  lines.push('- `<<PENDING_INPUT>>` — 你需要用户确认或提供更多信息后才能继续')
  lines.push('')

  const hasCompletionCheck = context.gates?.some(g => g.includes('[完成条件]'))

  if (context.requiresConfirm) {
    lines.push('### 本阶段需要用户确认')
    lines.push('')
    lines.push('本阶段设置了 `requires_confirm`，这意味着：')
    lines.push('')
    lines.push('1. **方案设计 / 产出就绪前**：你应该先向用户展示方案或产出概要，然后标记 `<<PENDING_INPUT>>` 等待用户反馈')
    lines.push('2. **用户确认后再次执行时**：你应该实施方案、生成所有产出物，完成后标记 `<<PHASE_COMPLETE>>`')
    lines.push('3. **如果你不确定用户意图或需要更多信息**：标记 `<<PENDING_INPUT>>`')
    lines.push('')
    lines.push('> 简言之：先展示方案等确认 → 确认后落地执行 → 执行完标记完成。')
  }

  if (hasCompletionCheck) {
    lines.push('')
    lines.push('### 完成条件验证')
    lines.push('')
    lines.push('上方门禁规则中列出了 ✅ [完成条件]，引擎会在你标记 `<<PHASE_COMPLETE>>` 后自动验证这些条件。')
    lines.push('你必须确保条件中描述的产出物已实际生成后，才能标记 `<<PHASE_COMPLETE>>`。')
    lines.push('如果你尚未生成这些产出物，必须标记 `<<PENDING_INPUT>>`。')
  }

  if (context.suspendable) {
    lines.push('')
    lines.push('### 本阶段支持挂起')
    lines.push('')
    lines.push('本阶段完成后，下一步可能需要等待外部依赖（如后端接口），用户可以选择挂起需求。')
    lines.push('挂起期间当前变更会自动提交保存。你无需处理挂起逻辑，但请在产出完成后告知用户可以选择「挂起需求」等待依赖就绪后再继续。')
  }

  if (!context.requiresConfirm && !hasCompletionCheck) {
    lines.push('如果你已完成所有产出，标记 `<<PHASE_COMPLETE>>`。')
    lines.push('如果你需要用户确认或提供更多信息，标记 `<<PENDING_INPUT>>`。')
  }

  lines.push('')
  lines.push('**不要遗漏此标记，它决定了工作流引擎如何推进。**')

  return `---\n\n${lines.join('\n')}`
}
