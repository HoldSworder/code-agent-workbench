import type Database from 'better-sqlite3'

export interface GateCheckDef {
  type: string
  path?: string
  pattern?: string
  after?: string
  command?: string
}

export interface GateDefinitionDef {
  description: string
  checks: GateCheckDef[]
}

export interface WorkflowStageInfo {
  id: string
  name: string
  gate?: string
  phases: Array<{
    id: string
    name: string
    optional?: boolean
    triggers?: string[]
  }>
}

export interface ToolInjectionContext {
  db: Database.Database
  repoTaskId: string
  currentPhaseId: string
  worktreePath: string
  dbPath: string
  openspecPath?: string
  gateDefinitions?: Record<string, GateDefinitionDef>
  currentPhaseGates?: { entryGate?: string, completionCheck?: string, stageGate?: string }
  currentStageId?: string
  workflowStages?: WorkflowStageInfo[]
}

export interface InjectedTool {
  id: string
  promptSection: string
}

export interface WorkflowTool {
  id: string
  name: string
  /** 注入条件的人类可读描述，用于 UI 展示 */
  description: string
  /** 注入条件的人类可读说明，如"当其他阶段存在对话时"或"始终注入" */
  injectionRule: string
  /** 命令用法摘要（纯文本），用于 UI 展示 */
  usage: string
  shouldInject(ctx: ToolInjectionContext): boolean
  resolveScript(ctx: ToolInjectionContext): string | null
  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string
}
