import type Database from 'better-sqlite3'

export interface ToolInjectionContext {
  db: Database.Database
  repoTaskId: string
  currentPhaseId: string
  worktreePath: string
  dbPath: string
}

export interface InjectedTool {
  id: string
  promptSection: string
}

export interface WorkflowTool {
  id: string
  name: string
  shouldInject(ctx: ToolInjectionContext): boolean
  resolveScript(ctx: ToolInjectionContext): string | null
  getPromptSection(ctx: ToolInjectionContext, scriptAbsPath: string): string
}
