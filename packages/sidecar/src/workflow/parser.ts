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

// ── 状态推断 ──

const StateInferenceRuleSchema = z.object({
  condition: z.string(),
  phase: z.string(),
  description: z.string().optional(),
})

const StateInferenceSchema = z.object({
  rules: z.array(StateInferenceRuleSchema),
})

// ── 触发语映射 ──

const TriggerMappingEntrySchema = z.object({
  patterns: z.array(z.string()),
  target: z.string(),
})

// ── 阶段配置 ──

const PhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  requires_confirm: z.boolean(),
  provider: z.enum(['api', 'external-cli', 'script']),
  skill: z.string().optional(),
  invoke_skills: z.array(z.string()).optional(),
  invoke_commands: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  confirm_files: z.array(z.string()).optional(),
  completion_check: z.string().optional(),
  script: z.string().optional(),
  args: z.array(z.string()).optional(),
  guardrails: z.array(z.string()).optional(),
})

// ── 事件配置 ──

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  after_phase: z.string(),
  skill: z.string().optional(),
  invoke_skills: z.array(z.string()).optional(),
  invoke_commands: z.array(z.string()).optional(),
  provider: z.enum(['api', 'external-cli', 'script']),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  confirm_files: z.array(z.string()).optional(),
  script: z.string().optional(),
  triggers: z.array(z.string()).optional(),
  precondition: z.string().optional(),
})

// ── 完整工作流 ──

const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string(),
  dependencies: z.record(z.string(), DependencySchema).optional(),
  state_inference: StateInferenceSchema.optional(),
  phases: z.array(PhaseSchema).min(1),
  events: z.array(EventSchema).optional(),
  trigger_mapping: z.array(TriggerMappingEntrySchema).optional(),
})

export type PhaseConfig = z.infer<typeof PhaseSchema>
export type EventConfig = z.infer<typeof EventSchema>
export type WorkflowConfig = z.infer<typeof WorkflowSchema>
export type StateInferenceRule = z.infer<typeof StateInferenceRuleSchema>
export type TriggerMappingEntry = z.infer<typeof TriggerMappingEntrySchema>
export type DependencyConfig = z.infer<typeof DependencySchema>

export function parseWorkflow(yamlContent: string): WorkflowConfig {
  const raw = parse(yamlContent)
  return WorkflowSchema.parse(raw)
}
