/**
 * 飞书项目工作项字段中按命名约定自动匹配前端 / 后端 / 测试故事点字段。
 *
 * 设计要点：
 * - 与具体 MCP 调用解耦：纯函数接收已解析的「字段清单」（fieldKey + label），返回匹配结果。
 *   方便单测构造各种 fixture，不必 mock MCP 协议。
 * - 同时返回 `allFields`：探测失败时供 UI 让用户从下拉里挑选 / 兜底覆盖，避免再发一次 RPC。
 */

export type StoryPointRole = 'frontend' | 'backend' | 'qa'

export interface StoryPointFieldRef {
  fieldKey: string
  label: string
}

export interface DetectStoryPointFieldsResult {
  frontend: StoryPointFieldRef | null
  backend: StoryPointFieldRef | null
  qa: StoryPointFieldRef | null
  allFields: StoryPointFieldRef[]
}

/** 角色 → label 关键词组（任一组全部命中即匹配）。同义词靠组之间的 OR 表达。 */
const ROLE_KEYWORD_GROUPS: Record<StoryPointRole, string[][]> = {
  frontend: [
    ['前端', '故事点'],
    ['frontend', 'point'],
    ['fe', 'point'],
    ['前端', 'story'],
  ],
  backend: [
    ['后端', '故事点'],
    ['backend', 'point'],
    ['be', 'point'],
    ['服务端', '故事点'],
    ['后端', 'story'],
  ],
  qa: [
    ['测试', '故事点'],
    ['qa', 'point'],
    ['质量', '故事点'],
    ['测试', 'story'],
  ],
}

function normalize(label: string): string {
  return label.toLowerCase().replace(/[\s_\-]/g, '')
}

function matchRole(label: string, role: StoryPointRole): boolean {
  const norm = normalize(label)
  return ROLE_KEYWORD_GROUPS[role].some(group => group.every(k => norm.includes(k.toLowerCase())))
}

/**
 * 从字段清单里按角色匹配。三角色独立匹配，命中即停。
 * 同一字段被多角色同时命中时，归给「最先命中的那个角色」（按 frontend → backend → qa 顺序）。
 */
export function detectStoryPointFields(fields: StoryPointFieldRef[]): DetectStoryPointFieldsResult {
  const used = new Set<string>()
  const out: DetectStoryPointFieldsResult = {
    frontend: null,
    backend: null,
    qa: null,
    allFields: fields.slice(),
  }
  const roles: StoryPointRole[] = ['frontend', 'backend', 'qa']
  for (const role of roles) {
    for (const f of fields) {
      if (used.has(f.fieldKey)) continue
      if (matchRole(f.label, role)) {
        out[role] = { fieldKey: f.fieldKey, label: f.label }
        used.add(f.fieldKey)
        break
      }
    }
  }
  return out
}

/**
 * 把飞书项目 MCP `list_workitem_field_config` 的原始返回 JSON 拍平为字段清单。
 *
 * 不同部署字段容器可能放在 `data.fields` / `fields` / `data.list` / 直接顶层数组等。
 * 这里采用「找到第一个 array of object 容器」的兜底策略，配合常见 alias key。
 */
export function flattenFieldList(json: unknown): StoryPointFieldRef[] {
  const candidates = extractFieldArrays(json)
  const out: StoryPointFieldRef[] = []
  const seen = new Set<string>()
  for (const arr of candidates) {
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const fieldKey = pickString(r, ['field_key', 'fieldKey', 'key', 'id'])
      if (!fieldKey || seen.has(fieldKey)) continue
      const label = pickString(r, ['field_alias', 'field_name', 'name', 'label', 'title']) || fieldKey
      out.push({ fieldKey, label })
      seen.add(fieldKey)
    }
  }
  return out
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function extractFieldArrays(node: unknown): Array<Record<string, unknown>[]> {
  const out: Array<Record<string, unknown>[]> = []
  visit(node, out, 0)
  return out
}

function visit(node: unknown, out: Array<Record<string, unknown>[]>, depth: number): void {
  if (!node || depth > 5) return
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(x => x && typeof x === 'object')) {
      out.push(node as Record<string, unknown>[])
    }
    return
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>))
      visit(v, out, depth + 1)
  }
}
