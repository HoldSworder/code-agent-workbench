import type { ExternalRuleConfig, GateDefinition, GuardrailDefinition, PhaseConfig } from './parser'
import type { ConversationTurn, ExternalRule, InvokedSkill, PhaseContext } from '../providers/types'

export interface ContextBuilderDeps {
  resolveSkillContent: (skillPath: string) => string
  guardrailDefinitions?: Record<string, GuardrailDefinition>
  gateDefinitions?: Record<string, GateDefinition>
  /** 工作流级别的外部规则定义 */
  externalRules?: ExternalRuleConfig[]
  /** 根据规则路径解析规则文件内容 */
  resolveRuleContent?: (rulePath: string) => string
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

function resolveGates(
  phase: PhaseConfig,
  stageGate: string | undefined,
  definitions?: Record<string, GateDefinition>,
): string[] | undefined {
  const lines: string[] = []

  if (phase.entry_gate) {
    const desc = definitions?.[phase.entry_gate]?.description ?? phase.entry_gate
    lines.push(`🔒 [入口门禁] ${phase.entry_gate}: ${desc}`)
  }
  if (phase.completion_check) {
    const desc = definitions?.[phase.completion_check]?.description ?? phase.completion_check
    lines.push(`✅ [完成条件] ${phase.completion_check}: ${desc}`)
  }
  if (stageGate) {
    const desc = definitions?.[stageGate]?.description ?? stageGate
    lines.push(`🏁 [Stage 完成门禁] ${stageGate}: 满足此条件后才能进入下一阶段 — ${desc}`)
  }

  return lines.length > 0 ? lines : undefined
}

function resolveExternalRules(
  ruleConfigs: ExternalRuleConfig[] | undefined,
  resolveContent?: (rulePath: string) => string,
): ExternalRule[] | undefined {
  if (!ruleConfigs?.length || !resolveContent) return undefined

  return ruleConfigs
    .map((rule) => {
      try {
        return { id: rule.id, content: resolveContent(rule.path) }
      }
      catch {
        return undefined
      }
    })
    .filter((r): r is ExternalRule => r != null && r.content.length > 0)
}

export interface RequirementInfo {
  title: string
  description: string
  docUrl?: string
  sourceUrl?: string
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
  stageGate?: string,
  injectedToolPrompts?: string[],
  mcpServerNames?: string[],
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
    requirementDocUrl: requirement?.docUrl,
    requirementSourceUrl: requirement?.sourceUrl,
    skillContent: leanMode ? '' : (phase.skill ? deps.resolveSkillContent(phase.skill) : ''),
    tools: phase.tools,
    mcpConfig: phase.mcp_config ?? undefined,
    userMessage,
    conversationHistory,
    invokeSkills: leanMode ? undefined : resolveInvokedSkills(phase.invoke_skills, deps),
    invokeCommands: leanMode ? undefined : interpolateCommands(phase.invoke_commands, templateVars),
    guardrails: leanMode ? undefined : resolveGuardrails(phase.guardrails, deps.guardrailDefinitions),
    gates: leanMode ? undefined : resolveGates(phase, stageGate, deps.gateDefinitions),
    externalRules: leanMode ? undefined : resolveExternalRules(deps.externalRules, deps.resolveRuleContent),
    requiresConfirm: phase.requires_confirm,
    suspendable: phase.suspendable,
    injectedToolPrompts: leanMode ? undefined : injectedToolPrompts,
    mcpServerNames: mcpServerNames?.length ? mcpServerNames : undefined,
  }
}
