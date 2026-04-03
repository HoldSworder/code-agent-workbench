import type { PhaseConfig } from './parser'
import type { PhaseContext } from '../providers/types'

export interface ContextBuilderDeps {
  resolveSkillContent: (skillPath: string) => string
}

export function buildPhaseContext(
  phase: PhaseConfig,
  repoPath: string,
  openspecPath: string,
  branchName: string,
  deps: ContextBuilderDeps,
  userMessage?: string,
): PhaseContext {
  return {
    phaseId: phase.id,
    repoPath,
    openspecPath,
    branchName,
    skillContent: phase.skill ? deps.resolveSkillContent(phase.skill) : '',
    tools: phase.tools,
    mcpConfig: phase.mcp_config ?? undefined,
    userMessage,
  }
}
