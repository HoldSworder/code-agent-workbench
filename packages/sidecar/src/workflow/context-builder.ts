import type { PhaseConfig } from './parser'
import type { ConversationTurn, InvokedSkill, PhaseContext } from '../providers/types'

export interface ContextBuilderDeps {
  resolveSkillContent: (skillPath: string) => string
}

/**
 * 将 invoke_skills 标识（如 "superpowers:brainstorming"）解析为完整内容。
 * 约定：标识格式为 "pack:skillName"，对应文件路径由 resolveSkillContent 负责。
 */
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

/**
 * 替换命令模板中的 {{var}} 占位符。
 */
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
    guardrails: leanMode ? undefined : phase.guardrails,
  }
}
