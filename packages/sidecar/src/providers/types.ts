import type { McpServerConfig as SdkMcpServerConfig } from '@cursor/sdk'

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

/**
 * 单会话模式下的全工作流 skill 总览条目。
 * 用于在初始 system prompt 里一次性提供所有 stage/phase 的 skill 内容，
 * agent 在后续推进阶段时直接复用上下文中的 skill，无需 engine 重新注入。
 */
export interface WorkflowSkillEntry {
  stageId: string
  stageName: string
  phaseId: string
  phaseName: string
  optional?: boolean
  /** 完整 skill markdown 内容（已经过模板插值） */
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
  /** Agent 以只读 plan 模式运行，仅分析输出方案，不修改文件 */
  planMode?: boolean
  /**
   * 单会话工作流模式下的全工作流 skill 总览。仅在工作流首次启动时注入，
   * resume 模式不再重复注入（agent 已在会话历史里看过）。
   */
  workflowSkillBundle?: WorkflowSkillEntry[]
  /**
   * 单会话工作流模式下的工作流总览（含 stage/phase 树、gate 说明、agent 自驱推进指南）。
   * 与 workflowSkillBundle 一起仅在首次启动时注入。
   */
  workflowOverview?: string
  /**
   * 单会话 SDK 模式下，inline 注入给 `Agent.create` / `Agent.resume` 的 MCP servers
   * （key = server 名）。替代旧 CLI 模式向工作目录写 .cursor/mcp.json 的做法，
   * 因为 SDK local agent 默认 settingSources=[] 不读取项目配置文件。
   */
  sdkMcpServers?: Record<string, SdkMcpServerConfig>
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
