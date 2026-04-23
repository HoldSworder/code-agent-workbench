import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { RenderedWorkflowSkill, WorkflowSkill, WorkflowSkillMeta } from './types'

const InputSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
})

const MetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  inputs: z.array(InputSchema).optional(),
  mcp_dependencies: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})

const ID_RE = /^[a-z0-9][a-z0-9-_]*$/i

function defaultSkillsRoot(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  // dev: packages/sidecar/src/workflow-skills  → 4 up to repo root
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'skills')
  if (existsSync(devPath)) return devPath
  // prod (dist): packages/sidecar/dist → 3 up to repo root
  return resolve(__dirname, '..', '..', '..', 'skills')
}

function readMeta(dir: string): WorkflowSkillMeta | null {
  const metaPath = join(dir, 'skill.json')
  if (!existsSync(metaPath)) return null
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf-8'))
    return MetaSchema.parse(raw)
  }
  catch {
    return null
  }
}

function readContent(dir: string): string {
  const mdPath = join(dir, 'SKILL.md')
  if (!existsSync(mdPath)) return ''
  return readFileSync(mdPath, 'utf-8')
}

export function scanWorkflowSkills(rootDir: string = defaultSkillsRoot()): WorkflowSkill[] {
  if (!existsSync(rootDir)) return []
  const skills: WorkflowSkill[] = []
  for (const name of readdirSync(rootDir)) {
    const dir = join(rootDir, name)
    let s
    try { s = statSync(dir) }
    catch { continue }
    if (!s.isDirectory()) continue
    const meta = readMeta(dir)
    if (!meta) continue
    // id 以目录名为权威
    meta.id = name
    skills.push({ meta, content: readContent(dir), dir })
  }
  return skills.sort((a, b) => a.meta.id.localeCompare(b.meta.id))
}

export function getWorkflowSkill(id: string, rootDir: string = defaultSkillsRoot()): WorkflowSkill | null {
  const dir = join(rootDir, id)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  const meta = readMeta(dir)
  if (!meta) return null
  meta.id = id
  return { meta, content: readContent(dir), dir }
}

export function renderWorkflowSkill(
  id: string,
  vars: Record<string, string>,
  rootDir: string = defaultSkillsRoot(),
): RenderedWorkflowSkill | null {
  const skill = getWorkflowSkill(id, rootDir)
  if (!skill) return null

  // 合并输入默认值
  const merged: Record<string, string> = {}
  for (const input of skill.meta.inputs ?? []) {
    if (input.default != null) merged[input.key] = input.default
  }
  for (const [k, v] of Object.entries(vars)) merged[k] = v

  const missing: string[] = []
  const content = skill.content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in merged) return merged[key]
    missing.push(key)
    return `{{${key}}}`
  })

  // 未填满的 required 输入也视为 missing
  for (const input of skill.meta.inputs ?? []) {
    if (input.required && !(input.key in merged) && !missing.includes(input.key))
      missing.push(input.key)
  }

  return { id, meta: skill.meta, content, missingVars: [...new Set(missing)] }
}

export interface CreateWorkflowSkillInput {
  id: string
  name: string
  description?: string
  content?: string
  inputs?: WorkflowSkillMeta['inputs']
  mcp_dependencies?: string[]
  tags?: string[]
}

function ensureValidId(id: string): void {
  if (!ID_RE.test(id))
    throw new Error(`非法 skill id: ${id}（仅允许字母、数字、-、_，且以字母或数字开头）`)
}

export function createWorkflowSkill(
  input: CreateWorkflowSkillInput,
  rootDir: string = defaultSkillsRoot(),
): WorkflowSkill {
  ensureValidId(input.id)
  const dir = join(rootDir, input.id)
  if (existsSync(dir)) throw new Error(`skill 已存在: ${input.id}`)
  mkdirSync(dir, { recursive: true })
  const meta: WorkflowSkillMeta = {
    id: input.id,
    name: input.name,
    description: input.description ?? '',
    inputs: input.inputs,
    mcp_dependencies: input.mcp_dependencies,
    tags: input.tags,
  }
  writeFileSync(join(dir, 'skill.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
  writeFileSync(join(dir, 'SKILL.md'), input.content ?? `# ${input.name}\n\n${input.description ?? ''}\n`, 'utf-8')
  return { meta, content: readContent(dir), dir }
}

export interface UpdateWorkflowSkillInput {
  id: string
  name?: string
  description?: string
  content?: string
  inputs?: WorkflowSkillMeta['inputs']
  mcp_dependencies?: string[]
  tags?: string[]
}

export function updateWorkflowSkill(
  input: UpdateWorkflowSkillInput,
  rootDir: string = defaultSkillsRoot(),
): WorkflowSkill {
  const existing = getWorkflowSkill(input.id, rootDir)
  if (!existing) throw new Error(`skill 不存在: ${input.id}`)
  const nextMeta: WorkflowSkillMeta = {
    ...existing.meta,
    name: input.name ?? existing.meta.name,
    description: input.description ?? existing.meta.description,
    inputs: input.inputs !== undefined ? input.inputs : existing.meta.inputs,
    mcp_dependencies: input.mcp_dependencies !== undefined ? input.mcp_dependencies : existing.meta.mcp_dependencies,
    tags: input.tags !== undefined ? input.tags : existing.meta.tags,
  }
  // 清理 undefined 字段，保持文件干净
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nextMeta))
    if (v !== undefined) clean[k] = v
  writeFileSync(join(existing.dir, 'skill.json'), `${JSON.stringify(clean, null, 2)}\n`, 'utf-8')
  if (input.content !== undefined)
    writeFileSync(join(existing.dir, 'SKILL.md'), input.content, 'utf-8')
  return getWorkflowSkill(input.id, rootDir)!
}

export function deleteWorkflowSkill(id: string, rootDir: string = defaultSkillsRoot()): void {
  ensureValidId(id)
  const dir = join(rootDir, id)
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
}

export function getWorkflowSkillsRoot(): string {
  return defaultSkillsRoot()
}
