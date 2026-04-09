import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { TeamConfig, RoleConfig } from './types'

const RoleSchema = z.object({
  description: z.string(),
  provider: z.enum(['claude-code', 'cursor-cli', 'codex']),
  model: z.string().optional(),
  prompt_template: z.string().optional(),
  prompt_file: z.string().optional(),
})

const PollingSchema = z.object({
  interval_seconds: z.number().int().positive(),
  board_filter: z
    .object({ status: z.string().optional() })
    .optional(),
})

const TeamConfigSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    polling: PollingSchema,
    roles: z.record(z.string(), RoleSchema).refine(
      roles => 'leader' in roles,
      { message: 'roles must include a "leader" role' },
    ),
  })

function resolvePrompt(role: RoleConfig, baseDir: string): string {
  if (role.prompt_file) {
    const filePath = resolve(baseDir, role.prompt_file)
    if (!existsSync(filePath))
      throw new Error(`prompt_file not found: ${filePath}`)
    return readFileSync(filePath, 'utf-8')
  }
  if (role.prompt_template)
    return role.prompt_template
  throw new Error('role must have either prompt_template or prompt_file')
}

export function parseTeamConfig(yamlContent: string, baseDir: string): TeamConfig {
  const raw = parse(yamlContent)
  const validated = TeamConfigSchema.parse(raw)

  const roles: Record<string, RoleConfig> = {}
  for (const [id, role] of Object.entries(validated.roles)) {
    const prompt = resolvePrompt(role as RoleConfig, baseDir)
    roles[id] = {
      description: role.description,
      provider: role.provider,
      model: role.model,
      prompt_template: prompt,
    }
  }

  return {
    name: validated.name,
    description: validated.description,
    polling: validated.polling,
    roles,
  }
}
