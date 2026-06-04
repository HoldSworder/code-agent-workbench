import type { ExternalRuleConfig, GateDefinition, GuardrailDefinition, PhaseConfig, StageConfig } from './parser'
import type { ConversationTurn, ExternalRule, InvokedSkill, PhaseContext, WorkflowSkillEntry } from '../providers/types'

export interface ContextBuilderDeps {
  resolveSkillContent: (skillPath: string) => string
  guardrailDefinitions?: Record<string, GuardrailDefinition>
  gateDefinitions?: Record<string, GateDefinition>
  /** 工作流级别的外部规则定义 */
  externalRules?: ExternalRuleConfig[]
  /** 根据规则路径解析规则文件内容 */
  resolveRuleContent?: (rulePath: string) => string
  /**
   * 解析根级 skill（`skills/<id>/`）内容。
   * skill 节点类型的 phase 通过此回调加载 SKILL.md 并完成变量插值。
   */
  resolveWorkflowSkill?: (id: string, vars: Record<string, string>) => {
    content: string
    missingVars: string[]
  } | null
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

/** 提取 gate 内 llm_judge check 的判定标准，作为 prompt 行追加给 agent。 */
function llmJudgeCriteria(
  gateName: string,
  definitions?: Record<string, GateDefinition>,
): string[] {
  const def = definitions?.[gateName]
  if (!def) return []
  return def.checks
    .filter(c => c.type === 'llm_judge' && c.prompt)
    .map(c => `    · [需 agent 自评] ${c.prompt}`)
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
    lines.push(...llmJudgeCriteria(phase.entry_gate, definitions))
  }
  if (phase.completion_check) {
    const desc = definitions?.[phase.completion_check]?.description ?? phase.completion_check
    lines.push(`✅ [完成条件] ${phase.completion_check}: ${desc}`)
    lines.push(...llmJudgeCriteria(phase.completion_check, definitions))
  }
  if (stageGate) {
    const desc = definitions?.[stageGate]?.description ?? stageGate
    lines.push(`🏁 [Stage 完成门禁] ${stageGate}: 满足此条件后才能进入下一阶段 — ${desc}`)
    lines.push(...llmJudgeCriteria(stageGate, definitions))
  }

  return lines.length > 0 ? lines : undefined
}

function resolveWorkflowSkillContent(
  phase: PhaseConfig,
  workflowVars: Record<string, string>,
  deps: ContextBuilderDeps,
): string {
  if (!phase.skill_ref || !deps.resolveWorkflowSkill) return ''

  // phase.skill_inputs 中的 value 本身支持 {{workflow_var}} 占位符，先插值一次再传给 skill
  const inputs: Record<string, string> = { ...workflowVars }
  if (phase.skill_inputs) {
    for (const [k, tpl] of Object.entries(phase.skill_inputs)) {
      inputs[k] = tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
        workflowVars[key] ?? `{{${key}}}`,
      )
    }
  }

  const rendered = deps.resolveWorkflowSkill(phase.skill_ref, inputs)
  if (!rendered) return `# Skill 未找到: ${phase.skill_ref}\n\n请在 skills/ 目录下检查该 skill 是否存在。`

  const header = `# Skill: ${phase.skill_ref}\n\n`
  const warn = rendered.missingVars.length
    ? `> ⚠️ 未填充的变量：${rendered.missingVars.join(', ')}\n\n`
    : ''
  return header + warn + rendered.content
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
 * 为单会话工作流模式构造「全工作流 skill 总览」：
 * 遍历所有 stage / phase，加载每个 phase 的 skill 文件内容（已插值），
 * 返回扁平数组供 buildPromptFromContext 渲染为 system prompt 头部。
 *
 * Note: 仅在工作流首次启动时调用，resume 模式不重复注入。
 */
export function buildWorkflowSkillBundle(
  stages: StageConfig[],
  templateVars: Record<string, string>,
  deps: ContextBuilderDeps,
): WorkflowSkillEntry[] {
  const bundle: WorkflowSkillEntry[] = []
  for (const stage of stages) {
    for (const phase of stage.phases) {
      let content = ''
      if (phase.type === 'skill' && phase.skill_ref)
        content = resolveWorkflowSkillContent(phase, templateVars, deps)
      else if (phase.skill)
        content = deps.resolveSkillContent(phase.skill)

      if (!content) continue
      bundle.push({
        stageId: stage.id,
        stageName: stage.name,
        phaseId: phase.id,
        phaseName: phase.name,
        optional: phase.optional,
        content,
      })
    }
  }
  return bundle
}

/**
 * 构造工作流总览文本：stage / phase 树 + gate 说明 + 自驱推进规则。
 * 与 buildWorkflowSkillBundle 一起作为单会话 init 阶段注入到 system prompt。
 */
export function buildWorkflowOverview(
  stages: StageConfig[],
  gateDefinitions?: Record<string, GateDefinition>,
): string {
  const lines: string[] = []
  lines.push('## 工作流总览（单会话模式）')
  lines.push('')
  lines.push('本次会话将串联整个研发工作流。下面是阶段树：')
  lines.push('')
  for (const stage of stages) {
    const gateNote = stage.gate ? ` — 🏁 stage 出口门禁: \`${stage.gate}\`` : ''
    lines.push(`- **${stage.name}** (\`${stage.id}\`)${gateNote}`)
    for (const phase of stage.phases) {
      const flags: string[] = []
      if (phase.optional) flags.push('optional')
      if (phase.requires_confirm) flags.push('需用户确认')
      if (phase.suspendable) flags.push('可挂起')
      if (phase.is_terminal) flags.push('终止节点')
      if (phase.completion_check) flags.push(`完成校验=${phase.completion_check}`)
      if (phase.entry_gate) flags.push(`入口门禁=${phase.entry_gate}`)
      const tag = flags.length ? `  _(${flags.join(', ')})_` : ''
      lines.push(`  - ${phase.name} (\`${phase.id}\`)${tag}`)
    }
  }

  if (gateDefinitions && Object.keys(gateDefinitions).length > 0) {
    lines.push('')
    lines.push('### Gate 定义')
    for (const [name, def] of Object.entries(gateDefinitions))
      lines.push(`- \`${name}\`: ${def.description}`)
  }

  lines.push('')
  lines.push('### 阶段自驱推进规则')
  lines.push('')
  lines.push('1. 每个 phase 完成后，**必须**调用 `advance-phase` 工具（详见下方工具说明）表达推进意图。Engine 会校验完成条件，过则推进、不过则把错误回传给你。')
  lines.push('2. 默认按阶段顺序串行推进。若需要激活 optional phase（如 integration 联调）或跳过某 phase，使用 `--mode target --target <phase_id>`。')
  lines.push('3. 若当前 phase 的产出还需要用户输入，**不要**强行调用 advance；改为 `--mode pending_input` 主动挂起。')
  lines.push('4. `requires_confirm: true` 的 phase 调用 advance 后会进入 `waiting_confirm`，用户在 UI 确认前你不会再收到消息——这是正常流程。')
  lines.push('5. 所有 phase 的 skill 内容都已经在本会话开局一次性提供，**按当前 phase 标识就近对应使用即可，不要重复读取技能文件**。')
  return lines.join('\n')
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
  planMode?: boolean,
  workflowSkillBundle?: WorkflowSkillEntry[],
  workflowOverview?: string,
): PhaseContext {
  const templateVars: Record<string, string> = {
    openspec_path: openspecPath,
    change_id: changeId,
    branch_name: branchName,
    repo_path: repoPath,
    requirement_title: requirement?.title ?? '',
    requirement_description: requirement?.description ?? '',
    requirement_doc_url: requirement?.docUrl ?? '',
    requirement_source_url: requirement?.sourceUrl ?? '',
  }

  const skillContent = leanMode
    ? ''
    : phase.type === 'skill' && phase.skill_ref
      ? resolveWorkflowSkillContent(phase, templateVars, deps)
      : phase.skill
        ? deps.resolveSkillContent(phase.skill)
        : ''

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
    skillContent,
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
    planMode: planMode || undefined,
    workflowSkillBundle: leanMode ? undefined : (workflowSkillBundle?.length ? workflowSkillBundle : undefined),
    workflowOverview: leanMode ? undefined : workflowOverview,
  }
}
