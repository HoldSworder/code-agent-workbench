export interface InvokedSkill {
  /** 技能标识，如 "superpowers:brainstorming" */
  id: string
  /** 技能的完整 Markdown 内容 */
  content: string
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface PhaseContext {
  phaseId: string
  repoPath: string
  openspecPath: string
  branchName: string
  skillContent: string
  tools?: string[]
  mcpConfig?: string
  userMessage?: string
  conversationHistory?: ConversationTurn[]
  /** Agent 需在本阶段调用的外部技能（已解析内容） */
  invokeSkills?: InvokedSkill[]
  /** Agent 需在本阶段执行的 CLI 命令模板（已替换变量） */
  invokeCommands?: string[]
  /** 本阶段的护栏规则 ID 列表 */
  guardrails?: string[]
  /** change-id，用于 openspec 命令 */
  changeId?: string
  /** 需求标题 */
  requirementTitle?: string
  /** 需求描述 */
  requirementDescription?: string
}

export interface PhaseResult {
  status: 'success' | 'failed' | 'cancelled'
  output?: string
  error?: string
  tokenUsage?: number
}

export interface RunOptions {
  onChunk?: (chunk: string) => void
}

export interface AgentProvider {
  run(context: PhaseContext, options?: RunOptions): Promise<PhaseResult>
  cancel(): Promise<void>
}
