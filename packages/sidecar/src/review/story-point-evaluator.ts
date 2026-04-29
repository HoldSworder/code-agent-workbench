import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { llmCall } from './llm'

export type Role = 'frontend' | 'backend' | 'qa'

export interface RoleResult {
  role: Role
  points: number
  rationale: string
}

export interface EvaluateInput {
  requirementTitle: string
  specMarkdown: string
  /** 评估规则文件路径；不传则读取 workflows/shared/story-point-rules.md */
  rulesFilePath?: string
  /** 上下文 cwd（默认 process.cwd()） */
  cwd?: string
}

const ROLE_LABELS: Record<Role, string> = { frontend: '前端', backend: '后端', qa: '测试' }

const SYSTEM_PROMPT = `你是经验丰富的工程师，按用户提供的规则给前端 / 后端 / 测试三个角色各自评估故事点。
请严格按 JSON Schema 输出（不要多余文本）：
{ "results": [{ "role": "frontend|backend|qa", "points": 1.5, "rationale": "..." }] }

要点：
1. points 用 0.5 步长（0、0.5、1、1.5、2、3、5、8）
2. rationale 要点说明工作量来源（页面/接口/复杂度）
3. 必须输出 3 个 role 各一项
4. 仅输出合法 JSON，不要 Markdown 代码围栏`.trim()

async function loadRules(input: EvaluateInput): Promise<string> {
  const cwd = input.cwd ?? process.cwd()
  const rulesPath = resolve(cwd, input.rulesFilePath ?? 'workflows/shared/story-point-rules.md')
  try {
    return await readFile(rulesPath, 'utf-8')
  }
  catch {
    return '（规则文件不存在；按通用工程经验估算）'
  }
}

function safeParseJson(text: string): { results?: RoleResult[] } | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(cleaned) }
  catch { return null }
}

export async function evaluateStoryPoints(input: EvaluateInput): Promise<RoleResult[]> {
  const rules = await loadRules(input)
  const userPrompt = [
    `# 需求\n${input.requirementTitle}`,
    `# 评估规则\n\n${rules}`,
    `# Dev-Spec\n\n${input.specMarkdown}`,
  ].join('\n\n---\n\n')

  const raw = await llmCall({ systemPrompt: SYSTEM_PROMPT, userPrompt, maxTokens: 1200 })
  const parsed = safeParseJson(raw)
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error(`AI 返回内容无法解析为评估结果: ${raw.slice(0, 200)}`)
  }

  const map = new Map<Role, RoleResult>()
  for (const item of parsed.results) {
    if (!item || !ROLE_LABELS[item.role as Role]) continue
    const points = Number(item.points)
    if (!Number.isFinite(points)) continue
    map.set(item.role as Role, {
      role: item.role as Role,
      points,
      rationale: String(item.rationale ?? ''),
    })
  }
  for (const role of Object.keys(ROLE_LABELS) as Role[]) {
    if (!map.has(role)) {
      map.set(role, { role, points: 0, rationale: 'AI 未返回该角色，记 0' })
    }
  }
  return ['frontend', 'backend', 'qa'].map(r => map.get(r as Role)!)
}

export function formatAssessmentMarkdown(results: RoleResult[]): string {
  const lines: string[] = []
  lines.push('## 故事点评估结果\n')
  lines.push('| 角色 | 故事点 | 评估理由 |')
  lines.push('| ---- | ------ | -------- |')
  for (const r of results) {
    const safeRationale = r.rationale.replace(/\n+/g, ' ').replace(/\|/g, '\\|')
    lines.push(`| ${ROLE_LABELS[r.role]} | ${r.points} | ${safeRationale} |`)
  }
  return lines.join('\n')
}
