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

export interface ExternalRule {
  id: string
  content: string
}

export interface PhaseContext {
  stageId: string
  stageName: string
  phaseId: string
  repoPath: string
  openspecPath: string
  branchName: string
  skillContent: string
  tools?: string[]
  mcpConfig?: string
  userMessage?: string
  conversationHistory?: ConversationTurn[]
  invokeSkills?: InvokedSkill[]
  invokeCommands?: string[]
  guardrails?: string[]
  /** 门禁规则描述，注入到 prompt 中让 Agent 感知 */
  gates?: string[]
  /** 外部规则，注入到 prompt 中约束 Agent 行为 */
  externalRules?: ExternalRule[]
  /** 本阶段完成后是否需要用户确认才能推进 */
  requiresConfirm?: boolean
  /** 本阶段完成后是否允许用户挂起需求 */
  suspendable?: boolean
  changeId?: string
  requirementTitle?: string
  requirementDescription?: string
  requirementDocUrl?: string
  requirementSourceUrl?: string
  /** 由 WorkflowTool 插件自动注入的工具说明段落 */
  injectedToolPrompts?: string[]
  /** 已注入到工作目录的 MCP server 名称列表 */
  mcpServerNames?: string[]
}

export interface PhaseResult {
  status: 'success' | 'failed' | 'cancelled' | 'pending_input'
  output?: string
  error?: string
  tokenUsage?: number
}

export interface RunOptions {
  onChunk?: (chunk: string) => void
  onActivity?: (entry: string) => void
}

export interface AgentProvider {
  run(context: PhaseContext, options?: RunOptions): Promise<PhaseResult>
  cancel(): Promise<void>
  readonly model?: string | null
}
