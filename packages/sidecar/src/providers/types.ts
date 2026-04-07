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
  changeId?: string
  requirementTitle?: string
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
  readonly model?: string | null
}
