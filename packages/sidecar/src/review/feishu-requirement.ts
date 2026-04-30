import { fetchLarkDocContent, parseLarkDocUrl } from '@code-agent/shared/lark'
import type { FeishuProjectMcpClient } from './feishu-project-mcp'
import { parseMcpJson } from './mcp-text'

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
  /** 拉取过程中遇到的非致命错误（例如 lark-cli 拉文档失败，但仍可降级用描述）。 */
  warnings: string[]
}

interface ResolveRequirementOptions {
  feishuMcp: FeishuProjectMcpClient
  /** 形如 `https://project.feishu.cn/{projectKey}/{type}/detail/{id}` 的工作项 URL。 */
  workItemUrl: string
  /** 注入用于测试；默认走 `@code-agent/shared/lark` 的 fetchLarkDocContent。 */
  fetchDocContent?: (url: string) => Promise<{ content: string, error?: string }>
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
 * 飞书项目 MCP `get_workitem_brief` 不同部署返回结构差异较大；本函数把所有可能的字段容器
 * 拉平成 `{ label, rawValue }[]`，避免上层 if-else 分支膨胀。
 *
 * 覆盖的容器：
 * - `work_item_attribute` / `work_item_attributes` / `extra_attributes`：飞书项目空间标准形态（首选）；
 * - `fields` / `field_value_pairs` / `custom_fields` / `field_keys`：旧版/通用形态。
 *
 * 顶层 `work_item_current_node` 等元字段不会被当作业务字段，避免污染匹配 / warnings 噪音。
 */
function flattenFields(workItem: Record<string, unknown>): FieldEntry[] {
  const out: FieldEntry[] = []
  const CONTAINER_KEYS = [
    'work_item_attribute',
    'work_item_attributes',
    'extra_attributes',
    'fields',
    'field_value_pairs',
    'custom_fields',
    'field_keys',
  ] as const
  const SKIP_TOP_LEVEL = new Set<string>([
    ...CONTAINER_KEYS,
    'work_item_current_node',
    'current_node',
    'workflow_infos',
    'sub_tasks',
    'related_work_items',
  ])

  for (const key of CONTAINER_KEYS) {
    const container = workItem[key]
    if (!Array.isArray(container)) continue
    for (const raw of container) {
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
  for (const k of ['name', 'title']) {
    const v = workItem[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
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

  const briefResult = await opts.feishuMcp.callTool('get_workitem_brief', {
    project_key: parsed.projectKey,
    work_item_id: parsed.workItemId,
    work_item_type_key: parsed.workItemType,
    // 显式传 _all 拿全字段；不同部署对该参数容忍度不同，失败时 catch 后退到无 fields。
    fields: ['_all'],
  }).catch(async () => opts.feishuMcp.callTool('get_workitem_brief', {
    project_key: parsed.projectKey,
    work_item_id: parsed.workItemId,
    work_item_type_key: parsed.workItemType,
  }))

  const json = parseMcpJson<unknown>(briefResult)
  const root = (json && typeof json === 'object') ? json as Record<string, unknown> : {}
  const dataNode = (root.data && typeof root.data === 'object') ? root.data as Record<string, unknown> : root
  const workItem = (Array.isArray((dataNode as { items?: unknown[] }).items) && ((dataNode as { items: unknown[] }).items[0] as Record<string, unknown>))
    || dataNode

  const title = pickTitle(workItem) || `工作项 ${parsed.workItemId}`
  const fields = flattenFields(workItem)
  const warnings: string[] = []

  for (const rule of FIELD_RULES) {
    for (const { label, rawValue } of fields) {
      const norm = normalizeLabel(label)
      if (!rule.keywords.some(k => norm.includes(k))) continue
      const valueStr = stringifyValue(rawValue)
      if (!valueStr) continue

      // 描述字段直接当 markdown 透传，不尝试解析 URL。
      if (rule.type === 'description') {
        return {
          workItemUrl: opts.workItemUrl,
          workItemId: parsed.workItemId,
          projectKey: parsed.projectKey,
          workItemType: parsed.workItemType,
          title,
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
            workItemUrl: opts.workItemUrl,
            workItemId: parsed.workItemId,
            projectKey: parsed.projectKey,
            workItemType: parsed.workItemType,
            title,
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
        workItemUrl: opts.workItemUrl,
        workItemId: parsed.workItemId,
        projectKey: parsed.projectKey,
        workItemType: parsed.workItemType,
        title,
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
    workItemUrl: opts.workItemUrl,
    workItemId: parsed.workItemId,
    projectKey: parsed.projectKey,
    workItemType: parsed.workItemType,
    title,
    sourceType: 'title_only',
    sourceFieldLabel: null,
    docUrl: null,
    content: '',
    warnings,
  }
}
