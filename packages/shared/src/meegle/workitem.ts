import { runMeegleCliJson, type RunMeegleCliOptions } from './cli'

/**
 * meegle CLI 成功路径直接返回业务体（如 `{ data: {...} }` / `{ list: [...] }`），
 * 失败路径才包成 `{ data: null, error: { code, message, retryable } }`。
 * 这里两种形态都识别。
 */
interface MeegleErrorEnvelope {
  data?: null
  error?: { code?: string, message?: string, retryable?: boolean } | null
}

function assertNoError(resp: MeegleErrorEnvelope, action: string): void {
  const err = resp?.error
  if (err && (err.message || err.code)) {
    throw new Error(`meegle ${action} 失败: ${err.message ?? err.code}`)
  }
}

export interface GetWorkItemArgs {
  projectKey: string
  workItemId: string | number
  /** 默认 ['_all']，传入 _all 时 meegle 会分页查询全部字段；本封装会自动跟随 next_page_token 把全部字段拼齐。 */
  fields?: string[]
  /** 自动翻页的最大页数硬上限，避免飞书项目侧故障无限循环。默认 20（即最多 20 * 100 = 2000 字段）。 */
  maxPages?: number
}

export interface MeegleWorkItem {
  work_item_attribute?: Record<string, unknown>
  work_item_fields?: unknown[]
  [key: string]: unknown
}

interface WorkItemPage {
  pagination?: { has_more?: boolean, next_page_token?: string }
  work_item_attribute?: Record<string, unknown>
  work_item_fields?: Array<Record<string, unknown>>
  work_item_current_node?: unknown
  [key: string]: unknown
}

/**
 * 调 `meegle workitem get` 拉单个工作项详情。
 *
 * meegle 实际返回结构：
 * ```
 * { pagination: { has_more, next_page_token, ... }, work_item_attribute: {...},
 *   work_item_fields: [{ key, name, value }, ...], work_item_current_node: {...} }
 * ```
 *
 * 当 fields=['_all'] 时单页只返回 100 个字段，需要透传 `next_page_token` 翻页拿全。
 * 这里自动翻页直到 `has_more=false`，把所有页的 `work_item_fields` 合并后返回，
 * `work_item_attribute` / `work_item_current_node` 取首页的（这些字段不分页）。
 */
export async function getWorkItem(args: GetWorkItemArgs, opts: RunMeegleCliOptions = {}): Promise<WorkItemPage> {
  const projectKey = args.projectKey?.trim()
  const workItemId = String(args.workItemId ?? '').trim()
  if (!projectKey) throw new Error('projectKey 必填')
  if (!workItemId) throw new Error('workItemId 必填')

  const fields = args.fields && args.fields.length > 0 ? args.fields : ['_all']
  const maxPages = Math.max(1, args.maxPages ?? 20)

  function buildArgs(pageToken?: string): string[] {
    const cliArgs = [
      'workitem', 'get',
      '--project-key', projectKey!,
      '--work-item-id', workItemId,
      '--format', 'json',
    ]
    for (const f of fields) cliArgs.push('--fields', f)
    if (pageToken) cliArgs.push('--page-token', pageToken)
    return cliArgs
  }

  const first = await runMeegleCliJson<MeegleErrorEnvelope & WorkItemPage>(buildArgs(), opts)
  assertNoError(first, 'workitem get')

  const merged: WorkItemPage = {
    pagination: first.pagination,
    work_item_attribute: first.work_item_attribute,
    work_item_current_node: first.work_item_current_node,
    work_item_fields: Array.isArray(first.work_item_fields) ? [...first.work_item_fields] : [],
  }

  let cursor = first.pagination?.next_page_token
  let hasMore = !!first.pagination?.has_more
  let pageCount = 1
  while (hasMore && cursor && pageCount < maxPages) {
    const next = await runMeegleCliJson<MeegleErrorEnvelope & WorkItemPage>(buildArgs(cursor), opts)
    assertNoError(next, 'workitem get (paged)')
    if (Array.isArray(next.work_item_fields))
      merged.work_item_fields!.push(...next.work_item_fields)
    cursor = next.pagination?.next_page_token
    hasMore = !!next.pagination?.has_more
    pageCount += 1
  }

  return merged
}

export interface ListMetaFieldsArgs {
  projectKey: string
  workItemType: string
  /** 模糊匹配字段名/key（透传 `--field-query`），不传则按页拉全部。 */
  fieldQuery?: string
  /** 单次最多翻多少页，避免飞书项目侧故障无限循环。默认 10。 */
  maxPages?: number
}

interface MetaFieldsResponse extends MeegleErrorEnvelope {
  list?: Array<Record<string, unknown>>
}

/**
 * 调 `meegle workitem meta-fields` 拉工作项类型字段清单，自动翻页直到返回空页。
 *
 * 与 MCP 的 `list_workitem_field_config` 输出结构一致（顶层 `list`），上层可继续用
 * `flattenFieldList` / `detectStoryPointFields`。
 */
export async function listMetaFields(args: ListMetaFieldsArgs, opts: RunMeegleCliOptions = {}): Promise<Array<Record<string, unknown>>> {
  const projectKey = args.projectKey?.trim()
  const workItemType = args.workItemType?.trim()
  if (!projectKey) throw new Error('projectKey 必填')
  if (!workItemType) throw new Error('workItemType 必填')

  const maxPages = Math.max(1, args.maxPages ?? 10)
  const out: Array<Record<string, unknown>> = []
  const seenKeys = new Set<string>()

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const cliArgs = [
      'workitem', 'meta-fields',
      '--project-key', projectKey,
      '--work-item-type', workItemType,
      '--page-num', String(pageNum),
      '--format', 'json',
    ]
    if (args.fieldQuery) cliArgs.push('--field-query', args.fieldQuery)

    const resp = await runMeegleCliJson<MetaFieldsResponse>(cliArgs, opts)
    assertNoError(resp, 'workitem meta-fields')
    const list = Array.isArray(resp.list) ? resp.list : []
    if (list.length === 0) break

    for (const item of list) {
      const key = typeof item.field_key === 'string' ? item.field_key : ''
      if (key && seenKeys.has(key)) continue
      if (key) seenKeys.add(key)
      out.push(item)
    }
    // 单页通常 50 条；不到 50 视为最后一页。
    if (list.length < 50) break
  }

  return out
}

export interface UpdateWorkItemArgs {
  projectKey: string
  workItemId: string | number
  /** 与飞书 OpenAPI `update_work_item` 一致：`[{ field_key, field_value }]`。 */
  fields: Array<{ field_key: string, field_value: unknown }>
}

/**
 * 调 `meegle workitem update` 写回工作项字段。
 *
 * `--fields` 在 CLI 是 string-array，这里按 JSON 字符串数组展开（每个元素是
 * `{"field_key":...,"field_value":...}` 的 JSON），与 meegle 在 update 路径的入参约定保持一致。
 */
export async function updateWorkItem(args: UpdateWorkItemArgs, opts: RunMeegleCliOptions = {}): Promise<unknown> {
  const projectKey = args.projectKey?.trim()
  const workItemId = String(args.workItemId ?? '').trim()
  if (!projectKey) throw new Error('projectKey 必填')
  if (!workItemId) throw new Error('workItemId 必填')
  if (!Array.isArray(args.fields) || args.fields.length === 0)
    throw new Error('fields 至少一项')

  const cliArgs = [
    'workitem', 'update',
    '--project-key', projectKey,
    '--work-item-id', workItemId,
    '--format', 'json',
  ]
  for (const f of args.fields) cliArgs.push('--fields', JSON.stringify(f))

  const resp = await runMeegleCliJson<MeegleErrorEnvelope & Record<string, unknown>>(cliArgs, opts)
  assertNoError(resp, 'workitem update')
  return resp
}
