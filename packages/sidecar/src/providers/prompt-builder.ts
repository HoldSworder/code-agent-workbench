import type { PhaseContext } from './types'

/**
 * 把 PhaseContext 渲染为发送给 agent 的完整 prompt。
 *
 * 单会话 + SDK 化后不再注入 `<<PHASE_COMPLETE>>` / `<<PENDING_INPUT>>` 文本信号协议：
 * agent 通过 advance-phase 工具写信号文件声明阶段意图，回合结束由 SDK 的
 * RunResult.status 判定，二者都不依赖 stdout 文本标记。
 */
export function buildPromptFromContext(context: PhaseContext, canReadFiles = true): string {
  const sections: string[] = []

  if (context.requirementTitle) {
    let reqSection = `## 需求\n\n**${context.requirementTitle}**`
    if (context.requirementSourceUrl)
      reqSection += `\n\n> 飞书项目链接: ${context.requirementSourceUrl}`
    if (context.requirementDocUrl)
      reqSection += `\n\n> 飞书需求文档: ${context.requirementDocUrl}`
    if (context.requirementDescription)
      reqSection += `\n\n${context.requirementDescription}`
    sections.push(reqSection)
  }

  if (context.mcpServerNames?.length) {
    sections.push(
      `---\n\n## 可用 MCP Server\n\n以下 MCP Server 已注入到当前工作目录，你可以直接通过 MCP tool 调用它们：\n\n${context.mcpServerNames.map(n => `- \`${n}\``).join('\n')}\n\n**重要**：直接使用 MCP tool 调用上述 server，不要尝试读取技能文件或通过子代理间接调用。`,
    )
  }

  if (context.workflowOverview)
    sections.push(`---\n\n${context.workflowOverview}`)

  if (context.workflowSkillBundle?.length) {
    const bundleSections: string[] = ['---', '', '## 全工作流 Skill 总览', '', '以下是本工作流所有 stage / phase 的 skill 内容，按阶段顺序排列。**当前 phase 的 skill 已用 ▶ 标记，请优先按其指引工作**；其它 phase 的 skill 作为后续阶段的参考，不要提前执行。']
    for (const entry of context.workflowSkillBundle) {
      const isCurrent = entry.phaseId === context.phaseId
      const marker = isCurrent ? '▶ ' : ''
      const opt = entry.optional ? ' _(optional)_' : ''
      bundleSections.push('')
      bundleSections.push(`### ${marker}${entry.stageName} / ${entry.phaseName} (\`${entry.phaseId}\`)${opt}`)
      bundleSections.push('')
      bundleSections.push(entry.content)
    }
    sections.push(bundleSections.join('\n'))
  }
  else if (context.skillContent) {
    sections.push(context.skillContent)
  }

  if (context.invokeSkills?.length) {
    if (canReadFiles) {
      sections.push('---\n\n## 必须调用的外部技能\n\n请先读取以下技能文件，然后按其中的指令执行：')
      for (const skill of context.invokeSkills)
        sections.push(`- \`${skill.id}\`: 请用工具读取此技能的完整内容后执行`)
    }
    else {
      sections.push('---\n\n## 必须调用的外部技能')
      for (const skill of context.invokeSkills)
        sections.push(`### INVOKE SKILL: \`${skill.id}\`\n\n${skill.content}`)
    }
  }

  if (context.invokeCommands?.length) {
    sections.push('---\n\n## 必须执行的 CLI 命令\n\n以下命令由你直接在终端执行：')
    sections.push(context.invokeCommands.map(cmd => `\`\`\`bash\n${cmd}\n\`\`\``).join('\n\n'))
  }

  if (context.gates?.length)
    sections.push(`---\n\n## 门禁规则\n\n以下条件用于判断本阶段的准入与完成，请在执行过程中关注这些条件：\n\n${context.gates.map(g => `- ${g}`).join('\n')}`)

  if (context.externalRules?.length) {
    sections.push('---\n\n## 外部规则\n\n以下规则为跨阶段共享的强制约束，必须在本阶段执行过程中遵守：')
    for (const rule of context.externalRules)
      sections.push(rule.content)
  }

  if (context.guardrails?.length)
    sections.push(`---\n\n## 护栏规则\n\n${context.guardrails.map(g => `- ${g}`).join('\n')}`)

  if (context.injectedToolPrompts?.length)
    sections.push(`---\n\n${context.injectedToolPrompts.join('\n\n---\n\n')}`)

  if (context.conversationHistory?.length) {
    sections.push('---\n\n## 历史对话')
    for (const turn of context.conversationHistory) {
      const prefix = turn.role === 'user' ? '**用户**' : '**助手**'
      sections.push(`${prefix}:\n${turn.content}`)
    }
  }

  if (context.userMessage)
    sections.push(`---\n\n## 用户最新反馈\n${context.userMessage}`)

  const ctxLines: string[] = []
  if (context.openspecPath) ctxLines.push(`- OpenSpec: ${context.openspecPath}`)
  if (context.branchName) ctxLines.push(`- 分支: ${context.branchName}`)
  if (context.changeId) ctxLines.push(`- change-id: ${context.changeId}`)
  if (ctxLines.length > 0) {
    ctxLines.unshift(`- 工作目录: ${context.repoPath}`)
    sections.push(`---\n\n## 上下文\n${ctxLines.join('\n')}`)
  }

  return sections.join('\n\n')
}
