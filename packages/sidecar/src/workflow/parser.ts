import { parse } from 'yaml'
import { z } from 'zod'

// ── 依赖声明 ──

const DependencySchema = z.object({
  type: z.enum(['cli', 'skill-pack']),
  check: z.string().optional(),
  install_hint: z.string().optional(),
  commands: z.array(z.string()).optional(),
  skills: z.record(z.string(), z.string()).optional(),
})

// ── Profile Detection ──

const ProfileSchema = z.object({
  markers: z.array(z.string()),
  indicators: z.array(z.string()).optional(),
  skill_dir: z.string(),
})

// ── 状态推断 ──

const StateInferenceRuleSchema = z.object({
  condition: z.string(),
  stage: z.string(),
  phase: z.string(),
  description: z.string().optional(),
})

const StateInferenceSchema = z.object({
  rules: z.array(StateInferenceRuleSchema),
})

// ── 触发语映射 ──

const TriggerMappingEntrySchema = z.object({
  patterns: z.array(z.string()),
  target_stage: z.string(),
  target_phase: z.string().optional(),
  strategy: z.enum(['infer_from_state']).optional(),
})

// ── Phase 进入时的输入收集 ──

const EntryInputSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
})

// ── Phase 配置（Stage 内子阶段） ──

const PhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(['api', 'external-cli', 'codex']),
  skill: z.string().optional(),
  invoke_skills: z.array(z.string()).optional(),
  invoke_commands: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  guardrails: z.array(z.string()).optional(),

  requires_confirm: z.boolean().optional().default(false),
  confirm_files: z.array(z.string()).optional(),
  completion_check: z.string().optional(),
  entry_gate: z.string().optional(),
  is_terminal: z.boolean().optional(),

  /** 完成后允许用户挂起需求（auto-commit 后进入 suspended 状态） */
  suspendable: z.boolean().optional(),
  /** 默认跳过，需要 trigger 激活才执行 */
  optional: z.boolean().optional(),
  /** 默认执行，用户可选择跳过 */
  skippable: z.boolean().optional(),
  /** 完成后可跳回 loop_target 重新执行 */
  loopable: z.boolean().optional(),
  /** loopable 为 true 时，循环回到的目标 phase id */
  loop_target: z.string().optional(),
  /** 激活 optional phase 的触发短语 */
  triggers: z.array(z.string()).optional(),
  /** optional phase 被激活进入时需要收集的用户输入 */
  entry_input: EntryInputSchema.optional(),
})

// ── Stage 配置（顶层阶段） ──

const StageSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 进入下一 Stage 前需满足的门禁条件 */
  gate: z.string().optional(),
  phases: z.array(PhaseSchema).min(1),
})

// ── 门禁定义（声明式条件检查） ──

const GateCheckSchema = z.object({
  type: z.enum([
    'exists',
    'not_exists',
    'file_contains',
    'file_not_contains',
    'file_section_matches',
    'file_section_not_matches',
    'command_succeeds',
  ]),
  /** 文件路径，支持 {{openspec_path}} 等模板变量。command_succeeds 类型不需要 */
  path: z.string().optional(),
  /** 用于 file_contains / file_not_contains 的子串匹配 */
  pattern: z.string().optional(),
  /** 用于 file_section_* 的分割标记（取标记之后的内容） */
  after: z.string().optional(),
  /** 用于 command_succeeds，在 worktree 目录下执行的 shell 命令，exit 0 = 通过 */
  command: z.string().optional(),
})

const GateDefinitionSchema = z.object({
  description: z.string(),
  checks: z.array(GateCheckSchema).min(1),
})

// ── 护栏定义 ──

const GuardrailDefinitionSchema = z.object({
  description: z.string(),
  severity: z.enum(['hard', 'soft']).default('soft'),
})

// ── 外部规则定义 ──

const ExternalRuleSchema = z.object({
  id: z.string(),
  /** 规则文件路径（相对于 workflow 所在目录或共享目录） */
  path: z.string(),
  /** 规则描述（用于日志和调试） */
  description: z.string().optional(),
})

// ── 完整工作流 ──

const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string(),
  profile_detection: z.record(z.string(), ProfileSchema).optional(),
  dependencies: z.record(z.string(), DependencySchema).optional(),
  gate_definitions: z.record(z.string(), GateDefinitionSchema).optional(),
  state_inference: StateInferenceSchema.optional(),
  guardrail_definitions: z.record(z.string(), GuardrailDefinitionSchema).optional(),
  /** 外部规则列表，注入到所有阶段的 prompt 中 */
  external_rules: z.array(ExternalRuleSchema).optional(),
  /** 需求收集阶段（独立于工作流 stages，在需求看板中执行） */
  requirement_phases: z.array(PhaseSchema).optional(),
  stages: z.array(StageSchema).min(1),
  trigger_mapping: z.array(TriggerMappingEntrySchema).optional(),
})

export type EntryInput = z.infer<typeof EntryInputSchema>
export type GateCheck = z.infer<typeof GateCheckSchema>
export type GateDefinition = z.infer<typeof GateDefinitionSchema>
export type PhaseConfig = z.infer<typeof PhaseSchema>
export type StageConfig = z.infer<typeof StageSchema>
export type WorkflowConfig = z.infer<typeof WorkflowSchema>
export type ProfileConfig = z.infer<typeof ProfileSchema>
export type StateInferenceRule = z.infer<typeof StateInferenceRuleSchema>
export type TriggerMappingEntry = z.infer<typeof TriggerMappingEntrySchema>
export type DependencyConfig = z.infer<typeof DependencySchema>
export type GuardrailDefinition = z.infer<typeof GuardrailDefinitionSchema>
export type ExternalRuleConfig = z.infer<typeof ExternalRuleSchema>

export function parseWorkflow(yamlContent: string): WorkflowConfig {
  const raw = parse(yamlContent)
  return WorkflowSchema.parse(raw)
}

// ── 辅助函数：扁平化获取所有 phases ──

export function flattenPhases(config: WorkflowConfig): (PhaseConfig & { stageId: string, stageName: string })[] {
  return config.stages.flatMap(stage =>
    stage.phases.map(phase => ({ ...phase, stageId: stage.id, stageName: stage.name })),
  )
}

export function findPhaseInStages(
  stages: StageConfig[],
  stageId: string,
  phaseId: string,
): { stage: StageConfig, phase: PhaseConfig, stageIdx: number, phaseIdx: number } | undefined {
  const stageIdx = stages.findIndex(s => s.id === stageId)
  if (stageIdx === -1) return undefined
  const stage = stages[stageIdx]
  const phaseIdx = stage.phases.findIndex(p => p.id === phaseId)
  if (phaseIdx === -1) return undefined
  return { stage, phase: stage.phases[phaseIdx], stageIdx, phaseIdx }
}

export function findPhaseById(
  stages: StageConfig[],
  phaseId: string,
): { stage: StageConfig, phase: PhaseConfig, stageIdx: number, phaseIdx: number } | undefined {
  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si]
    for (let pi = 0; pi < stage.phases.length; pi++) {
      if (stage.phases[pi].id === phaseId)
        return { stage, phase: stage.phases[pi], stageIdx: si, phaseIdx: pi }
    }
  }
  return undefined
}

/**
 * 获取 Stage 中最后一个必选（非 optional）Phase 的 id。
 * Stage gate 仅应注入到此 Phase 的提示词中，避免误导其他 Phase 的 Agent。
 */
export function getLastMandatoryPhaseId(stage: StageConfig): string | undefined {
  for (let i = stage.phases.length - 1; i >= 0; i--) {
    if (!stage.phases[i].optional)
      return stage.phases[i].id
  }
  return undefined
}
