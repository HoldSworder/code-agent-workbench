import { fetchLarkDocContent, parseLarkDocUrl } from '@code-agent/shared/lark'
import { getWorkItem } from '@code-agent/shared/meegle'

/**
 * 解析后的需求来源描述，供 design-generator 拼 userPrompt 使用。
 *
 * `sourceType` 命名遵循 OpenSpec / 内部 review 文档的术语：
 * - `spec_doc`：飞书项目「需求SPEC文档」字段，最高优先级；
 * - `requirement_doc`：飞书项目「需求文档」字段；
 * - `description`：飞书项目「描述」字段；
 * - `title_only`：以上三者均未命中，仅用工作项标题作 fallback。
 */
export type RequirementSourceType = 'spec_doc' | 'requirement_doc' | 'description' | 'title_only'

/**
 * 飞书项目工作项里供前端卡片直接展示的「描述/需求文档/SPEC文档」三件套。
 * 与 `RequirementSource.sourceType / content` 解耦：这三个字段是「原始值」展示用，
 * 而 `content` 是按优先级解析后给 LLM 用的纯文本。
 */
export interface FeishuRequirementFields {
  /** 「描述」字段原值；通常是富文本 markdown。 */
  description: string | null
  /** 「需求文档」字段原值（飞书云文档 URL，少数情况是 inline markdown）。 */
  requirementDocUrl: string | null
  /** 「需求SPEC文档」字段原值（飞书云文档 URL，少数情况是 inline markdown）。 */
  specDocUrl: string | null
}

export interface RequirementSource {
  workItemUrl: string
  workItemId: string
  projectKey: string
  workItemType: string
  title: string
  sourceType: RequirementSourceType
  /** 命中字段在飞书项目里的显示名（便于 UI 提示「来自：需求SPEC文档」）。 */
  sourceFieldLabel: string | null
  /** 命中字段所携带的飞书文档 URL；title_only/description 时为 null。 */
  docUrl: string | null
  /** 真正供 LLM 使用的纯文本内容；spec_doc/requirement_doc 是抓取的 markdown，description 是字段原值。 */
  content: string
  /** 飞书工作项里「描述/需求文档/SPEC文档」三个原始字段值（供 UI 卡片展示，不参与 LLM）。 */
  feishuFields: FeishuRequirementFields
  /** 拉取过程中遇到的非致命错误（例如 lark-cli 拉文档失败，但仍可降级用描述）。 */
  warnings: string[]
}

interface ResolveRequirementOptions {
  /** 形如 `https://project.feishu.cn/{projectKey}/{type}/detail/{id}` 的工作项 URL。 */
  workItemUrl: string
  /** 注入用于测试；默认走 `@code-agent/shared/lark` 的 fetchLarkDocContent。 */
  fetchDocContent?: (url: string) => Promise<{ content: string, error?: string }>
  /** 注入用于测试；默认走 `@code-agent/shared/meegle` 的 getWorkItem。 */
  fetchWorkItem?: (args: { projectKey: string, workItemId: string }) => Promise<unknown>
}

interface ParsedFeishuUrl {
  projectKey: string
  workItemType: string
  workItemId: string
}

/** 关键字 → sourceType 的优先级有序表，匹配时严格按数组顺序遍历。 */
const FIELD_RULES: Array<{ type: Exclude<RequirementSourceType, 'title_only'>, keywords: string[] }> = [
  { type: 'spec_doc', keywords: ['需求spec文档', '需求spec', 'spec文档', 'specdoc', 'requirementspec'] },
  { type: 'requirement_doc', keywords: ['需求文档', 'requirementdoc'] },
  { type: 'description', keywords: ['描述', 'description'] },
]

/** url 形如 `https://project.feishu.cn/abc123/issue/detail/456` 或 ……/story/detail/789。 */
function parseWorkItemUrl(url: string): ParsedFeishuUrl | null {
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    // 期望 [projectKey, workItemType, 'detail', workItemId]
    const detailIdx = segs.findIndex(s => s === 'detail')
    if (detailIdx < 1 || detailIdx >= segs.length - 1) return null
    const projectKey = segs[detailIdx - 2]
    const workItemType = segs[detailIdx - 1]
    const workItemId = segs[detailIdx + 1]
    if (!projectKey || !workItemType || !workItemId) return null
    return { projectKey, workItemType, workItemId }
  }
  catch {
    return null
  }
}

interface FieldEntry {
  label: string
  rawValue: unknown
}

/**
 * 把飞书项目工作项里的字段容器拉平成 `{ label, rawValue }[]`，避免上层 if-else 分支膨胀。
 *
 * 覆盖的形态（按优先级）：
 * - **meegle CLI 当前形态**（首选）：
 *   - `work_item_fields: [{ key, name, value }, ...]` — 业务字段数组
 *   - `work_item_attribute: { work_item_name, work_item_id, work_item_status, ... }` — 元属性对象，**不**作为业务字段拉入
 * - 历史 MCP 形态（保留兼容）：
 *   - `work_item_attribute` / `work_item_attributes` / `extra_attributes` 是数组，元素含 `field_alias` / `field_value`
 *   - `fields` / `field_value_pairs` / `custom_fields` / `field_keys` 数组
 *
 * 顶层 `work_item_current_node` / `pagination` 等元字段不会被当作业务字段。
 */
function flattenFields(workItem: Record<string, unknown>): FieldEntry[] {
  const out: FieldEntry[] = []
  const ARRAY_CONTAINER_KEYS = [
    'work_item_fields', // ← meegle 实际产出
    'work_item_attributes',
    'extra_attributes',
    'fields',
    'field_value_pairs',
    'custom_fields',
    'field_keys',
  ] as const
  const SKIP_TOP_LEVEL = new Set<string>([
    ...ARRAY_CONTAINER_KEYS,
    'work_item_attribute',
    'work_item_current_node',
    'current_node',
    'workflow_infos',
    'sub_tasks',
    'related_work_items',
    'pagination',
  ])

  for (const key of ARRAY_CONTAINER_KEYS) {
    const container = workItem[key]
    if (!Array.isArray(container)) continue
    for (const raw of container) {
      if (!raw || typeof raw !== 'object') continue
      const f = raw as Record<string, unknown>
      const labelRaw = (f.field_alias ?? f.field_name ?? f.name ?? f.label ?? f.key ?? f.field_key ?? '') as unknown
      const label = typeof labelRaw === 'string' ? labelRaw : String(labelRaw ?? '')
      const valueRaw = f.field_value ?? f.value ?? f.text ?? f
      out.push({ label, rawValue: valueRaw })
    }
  }
  // 历史 MCP 兼容：`work_item_attribute` 数组形态（meegle 下它是对象，会被下面的 isArray 检查跳过）。
  if (Array.isArray(workItem.work_item_attribute)) {
    for (const raw of workItem.work_item_attribute) {
      if (!raw || typeof raw !== 'object') continue
      const f = raw as Record<string, unknown>
      const labelRaw = (f.field_alias ?? f.field_name ?? f.name ?? f.label ?? f.field_key ?? '') as unknown
      const label = typeof labelRaw === 'string' ? labelRaw : String(labelRaw ?? '')
      const valueRaw = f.field_value ?? f.value ?? f.text ?? f
      out.push({ label, rawValue: valueRaw })
    }
  }
  // 顶层未结构化字段，部分部署直接把字段 key 作为 workItem 的属性挂上来。
  for (const [k, v] of Object.entries(workItem)) {
    if (SKIP_TOP_LEVEL.has(k)) continue
    out.push({ label: k, rawValue: v })
  }
  return out
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s|_|-/g, '')
}

/**
 * 把字段值规整为字符串：
 * - 字符串 → 直接返回
 * - 富文本/选项对象 → 取 url/text/label/value 任一
 * - 数组 → 取第一个非空字符串
 * 其它返回 ''。
 */
function stringifyValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = stringifyValue(item)
      if (s) return s
    }
    return ''
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['url', 'text', 'label', 'value', 'content', 'name']) {
      const s = stringifyValue(o[k])
      if (s) return s
    }
  }
  return ''
}

function pickTitle(workItem: Record<string, unknown>): string {
  // meegle 实际形态：title 在 `work_item_attribute.work_item_name` 上。
  const attr = workItem.work_item_attribute
  if (attr && typeof attr === 'object' && !Array.isArray(attr)) {
    const a = attr as Record<string, unknown>
    for (const k of ['work_item_name', 'name', 'title']) {
      const v = a[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  // 兼容历史 MCP 顶层挂 name/title 的形态。
  for (const k of ['name', 'title', 'work_item_name']) {
    const v = workItem[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 从拉平后的字段表里挑出「描述/需求文档/SPEC文档」三件套，供前端卡片展示。
 * 与 FIELD_RULES 共享关键字判定，但走「最先命中」策略：每类只取一个。
 */
function pickFeishuFields(fields: FieldEntry[]): FeishuRequirementFields {
  const out: FeishuRequirementFields = {
    description: null,
    requirementDocUrl: null,
    specDocUrl: null,
  }
  for (const { label, rawValue } of fields) {
    const norm = normalizeLabel(label)
    const value = stringifyValue(rawValue)
    if (!value) continue
    if (out.specDocUrl == null && FIELD_RULES[0].keywords.some(k => norm.includes(k))) {
      out.specDocUrl = value
      continue
    }
    if (out.requirementDocUrl == null && FIELD_RULES[1].keywords.some(k => norm.includes(k))) {
      out.requirementDocUrl = value
      continue
    }
    if (out.description == null && FIELD_RULES[2].keywords.some(k => norm.includes(k))) {
      out.description = value
      continue
    }
  }
  return out
}

/**
 * 按需求SPEC文档 → 需求文档 → 描述的优先级，从飞书项目工作项里抽取需求来源。
 *
 * 实现要点：
 * - 命中 spec_doc / requirement_doc 时，若值是飞书云文档 URL，再调 `fetchLarkDocContent` 抓 markdown；
 *   抓失败时不阻塞主流程，记录到 `warnings` 并降级使用字段原文 / 标题。
 * - 命中 description 时直接当 markdown 透传，不再尝试拉文档。
 * - 三者皆无时，返回 `title_only` 来源，content 为空字符串，由上层决定是否阻断。
 */
export async function resolveRequirementDoc(opts: ResolveRequirementOptions): Promise<RequirementSource> {
  const parsed = parseWorkItemUrl(opts.workItemUrl)
  if (!parsed) throw new Error(`无法解析飞书项目工作项 URL: ${opts.workItemUrl}`)

  const fetchContent = opts.fetchDocContent ?? (async (url: string) => fetchLarkDocContent(url))
  const fetchWorkItem = opts.fetchWorkItem ?? (async ({ projectKey, workItemId }) => getWorkItem({ projectKey, workItemId }))

  // 显式传 _all 拿全字段；不同部署对该参数容忍度不同，失败时 catch 后退到默认字段集。
  const briefResult = await fetchWorkItem({
    projectKey: parsed.projectKey,
    workItemId: parsed.workItemId,
  })

  const root = (briefResult && typeof briefResult === 'object') ? briefResult as Record<string, unknown> : {}
  const dataNode = (root.data && typeof root.data === 'object') ? root.data as Record<string, unknown> : root
  const workItem = (Array.isArray((dataNode as { items?: unknown[] }).items) && ((dataNode as { items: unknown[] }).items[0] as Record<string, unknown>))
    || dataNode

  const title = pickTitle(workItem) || `工作项 ${parsed.workItemId}`
  const fields = flattenFields(workItem)
  const feishuFields = pickFeishuFields(fields)
  const warnings: string[] = []

  const baseResult = {
    workItemUrl: opts.workItemUrl,
    workItemId: parsed.workItemId,
    projectKey: parsed.projectKey,
    workItemType: parsed.workItemType,
    title,
    feishuFields,
  }

  for (const rule of FIELD_RULES) {
    for (const { label, rawValue } of fields) {
      const norm = normalizeLabel(label)
      if (!rule.keywords.some(k => norm.includes(k))) continue
      const valueStr = stringifyValue(rawValue)
      if (!valueStr) continue

      // 描述字段直接当 markdown 透传，不尝试解析 URL。
      if (rule.type === 'description') {
        return {
          ...baseResult,
          sourceType: 'description',
          sourceFieldLabel: label || null,
          docUrl: null,
          content: valueStr,
          warnings,
        }
      }

      // spec_doc / requirement_doc：值期望是飞书云文档 URL；若不是，仍当文本内容用。
      if (parseLarkDocUrl(valueStr)) {
        const docResult = await fetchContent(valueStr)
        if (docResult.content) {
          return {
            ...baseResult,
            sourceType: rule.type,
            sourceFieldLabel: label || null,
            docUrl: valueStr,
            content: docResult.content,
            warnings,
          }
        }
        warnings.push(`「${label}」文档抓取失败：${docResult.error ?? '未知错误'}，已降级到下一来源`)
        continue
      }

      // 字段值不是 URL 但有内容（如直接贴的 markdown），直接用作 content。
      return {
        ...baseResult,
        sourceType: rule.type,
        sourceFieldLabel: label || null,
        docUrl: null,
        content: valueStr,
        warnings,
      }
    }
  }

  // 三组关键词都没命中时，把工作项里实际存在的字段 label 列出来（去空 / 去重 / 截断），
  // 便于用户对照「需求SPEC文档/需求文档/描述」三组目标关键词手动确认飞书项目里真实的字段名，
  // 进而决定是否需要扩展 FIELD_RULES。
  const detectedLabels = Array.from(new Set(
    fields.map(f => f.label).filter(s => typeof s === 'string' && s.trim().length > 0),
  )).slice(0, 50)
  if (detectedLabels.length > 0) {
    warnings.push(
      `飞书工作项实际字段：${detectedLabels.join('、')}。`
      + '若其中某个字段就是需求来源（spec/需求文档/描述），请反馈字段名以扩展匹配规则。',
    )
  }
  else {
    warnings.push('飞书项目 MCP 返回的工作项里未发现任何字段；可能是 get_workitem_brief 鉴权或字段权限问题。')
  }

  return {
    ...baseResult,
    sourceType: 'title_only',
    sourceFieldLabel: null,
    docUrl: null,
    content: '',
    warnings,
  }
}
