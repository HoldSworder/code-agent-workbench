export interface PhaseContext {
  phaseId: string
  repoPath: string
  openspecPath: string
  branchName: string
  skillContent: string
  tools?: string[]
  mcpConfig?: string
  userMessage?: string
}

export interface PhaseResult {
  status: 'success' | 'failed' | 'cancelled'
  output?: string
  error?: string
  tokenUsage?: number
}

export interface AgentProvider {
  run(context: PhaseContext): Promise<PhaseResult>
  cancel(): Promise<void>
}
