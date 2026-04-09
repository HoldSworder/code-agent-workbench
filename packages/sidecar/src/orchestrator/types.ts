export type ProviderType = 'claude-code' | 'cursor-cli' | 'codex'

export interface RoleConfig {
  description: string
  provider: ProviderType
  model?: string
  prompt_template?: string
  prompt_file?: string
}

export interface PollingConfig {
  interval_seconds: number
  board_filter?: {
    status?: string
  }
}

export interface TeamConfig {
  name: string
  description?: string
  polling: PollingConfig
  roles: Record<string, RoleConfig>
}

export type LeaderDecisionType = 'single_worker' | 'split' | 'blocked'

export interface LeaderAssignment {
  role: string
  title: string
  description: string
  acceptance_criteria?: string
}

export interface LeaderDecision {
  decision: LeaderDecisionType
  reason: string
  assignments: LeaderAssignment[]
}

export type OrchestratorRunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled'
export type AssignmentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type RequirementMode = 'workflow' | 'orchestrator'

export interface OrchestratorRun {
  id: string
  requirement_id: string
  team_config: string
  status: OrchestratorRunStatus
  leader_decision: string | null
  created_at: string
  completed_at: string | null
}

export interface Assignment {
  id: string
  run_id: string
  role: string
  title: string
  description: string
  acceptance_criteria: string | null
  worktree_path: string | null
  branch_name: string | null
  status: AssignmentStatus
  agent_provider: string | null
  agent_model: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export type OrchestratorEventType =
  | 'leader_started'
  | 'leader_output_invalid'
  | 'requirement_analyzed'
  | 'task_assigned'
  | 'worker_started'
  | 'worker_output'
  | 'worker_completed'
  | 'worker_failed'
  | 'worker_timeout'
  | 'run_completed'
  | 'run_failed'
  | 'run_blocked'
  | 'run_cancelled'
  | 'run_rejected'

export interface OrchestratorEvent {
  id: number
  run_id: string
  assignment_id: string | null
  event_type: OrchestratorEventType
  payload: string | null
  created_at: string
}

export interface CreateRunInput {
  requirement_id: string
  team_config: string
}

export interface CreateAssignmentInput {
  run_id: string
  role: string
  title: string
  description: string
  acceptance_criteria?: string
  agent_provider?: string
  agent_model?: string
}
