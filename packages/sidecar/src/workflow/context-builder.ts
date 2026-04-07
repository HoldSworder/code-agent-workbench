import type { GuardrailDefinition, PhaseConfig } from './parser'
import type { ConversationTurn, InvokedSkill, PhaseContext } from '../providers/types'

export interface ContextBuilderDeps {
  resolveSkillContent: (skillPath: string) => string
  guardrailDefinitions?: Record<string, GuardrailDefinition>
}

function resolveInvokedSkills(
  skillIds: string[] | undefined,
  deps: ContextBuilderDeps,
): InvokedSkill[] | undefined {
  if (!skillIds?.length)
    return undefined

  return skillIds.map(id => ({
    id,
    content: deps.resolveSkillContent(id),
  }))
}

function interpolateCommands(
  commands: string[] | undefined,
  vars: Record<string, string>,
): string[] | undefined {
  if (!commands?.length)
    return undefined

  return commands.map(cmd =>
    cmd.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`),
  )
}

function resolveGuardrails(
  ids: string[] | undefined,
  definitions?: Record<string, GuardrailDefinition>,
): string[] | undefined {
  if (!ids?.length) return undefined

  return ids.map((id) => {
    const def = definitions?.[id]
    if (!def) return id
    const prefix = def.severity === 'hard' ? '🚫 [强制]' : '⚠️ [建议]'
    return `${prefix} ${def.description}`
  })
}

export interface RequirementInfo {
  title: string
  description: string
}

/**
 * @param leanMode - When true (session resume), skip heavy skill content
 *   to minimize prompt size for faster agent startup.
 */
export function buildPhaseContext(
  phase: PhaseConfig,
  stageId: string,
  stageName: string,
  repoPath: string,
  openspecPath: string,
  branchName: string,
  changeId: string,
  deps: ContextBuilderDeps,
  userMessage?: string,
  conversationHistory?: ConversationTurn[],
  leanMode?: boolean,
  requirement?: RequirementInfo,
): PhaseContext {
  const templateVars: Record<string, string> = {
    openspec_path: openspecPath,
    change_id: changeId,
    branch_name: branchName,
    repo_path: repoPath,
  }

  return {
    stageId,
    stageName,
    phaseId: phase.id,
    repoPath,
    openspecPath,
    branchName,
    changeId,
    requirementTitle: requirement?.title,
    requirementDescription: requirement?.description,
    skillContent: leanMode ? '' : (phase.skill ? deps.resolveSkillContent(phase.skill) : ''),
    tools: phase.tools,
    mcpConfig: phase.mcp_config ?? undefined,
    userMessage,
    conversationHistory,
    invokeSkills: leanMode ? undefined : resolveInvokedSkills(phase.invoke_skills, deps),
    invokeCommands: leanMode ? undefined : interpolateCommands(phase.invoke_commands, templateVars),
    guardrails: leanMode ? undefined : resolveGuardrails(phase.guardrails, deps.guardrailDefinitions),
  }
}
