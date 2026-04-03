import { parse } from 'yaml'
import { z } from 'zod'

const PhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  requires_confirm: z.boolean(),
  provider: z.enum(['api', 'external-cli', 'script']),
  skill: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  confirm_files: z.array(z.string()).optional(),
  completion_check: z.string().optional(),
  script: z.string().optional(),
  args: z.array(z.string()).optional(),
})

const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  after_phase: z.string(),
  skill: z.string().optional(),
  provider: z.enum(['api', 'external-cli', 'script']),
  tools: z.array(z.string()).optional(),
  mcp_config: z.string().nullable().optional(),
  confirm_files: z.array(z.string()).optional(),
  script: z.string().optional(),
})

const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string(),
  phases: z.array(PhaseSchema).min(1),
  events: z.array(EventSchema).optional(),
})

export type PhaseConfig = z.infer<typeof PhaseSchema>
export type EventConfig = z.infer<typeof EventSchema>
export type WorkflowConfig = z.infer<typeof WorkflowSchema>

export function parseWorkflow(yamlContent: string): WorkflowConfig {
  const raw = parse(yamlContent)
  return WorkflowSchema.parse(raw)
}
