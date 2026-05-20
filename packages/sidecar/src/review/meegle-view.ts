import { runMeegleCliJson } from '@code-agent/shared/meegle'

/**
 * 视图工作项的最小标准化结构，桌面端直接渲染。
 * 找不到的字段填 null/空数组，不抛错。
 */
export interface NormalizedViewItem {
  id: string
  title: string | null
  statusLabel: string | null
  ownerNames: string[]
  sourceUrl: string
}

/**
 * meegle CLI `view get` 在成功路径直接返回业务体顶层：
 *   { pagination: {...}, work_item_list: [...] }
 * 失败路径才包成 `{ data: null, error: { code, message } }`。
 * 这里两种形态都兼容。
 */
interface MeegleViewGetSuccess {
  pagination?: { has_more?: boolean, page_num?: number, page_size?: number, total?: number }
  work_item_list?: WorkItem[]
}

interface MeegleViewGetError {
  data?: null
  error?: { code?: string, message?: string, retryable?: boolean } | null
}

type MeegleViewGetResponse = MeegleViewGetSuccess & MeegleViewGetError

interface RoleMember { name?: string }
interface RoleEntry { key?: string, name?: string, members?: RoleMember[] }
interface NamedRef { key?: string, name?: string }

/** 飞书项目 OpenAPI 的工作项标准结构（meegle CLI 透传，与老版 MCP 字段命名不同）。 */
interface WorkItem {
  work_item_attribute?: {
    work_item_id?: string | number
    work_item_name?: string
    work_item_status?: NamedRef
    work_item_type?: NamedRef
    role_members?: RoleEntry[]
  }
  work_item_fields?: unknown[]
}

export interface ListViewItemsArgs {
  projectKey: string
  workItemType: string
  viewId: string
  pageNum?: number
}

export interface ListViewItemsResult {
  items: NormalizedViewItem[]
  pageNum: number
  hasMore: boolean
  total: number | null
  /** meegle CLI 实际返回的原文摘要，列表为空时回传给前端便于排错。 */
  rawSnippet: string | null
}

/**
 * 角色 owner 提取策略：优先抓与"研发/开发/产品/测试"相关的核心角色，避免一次堆几十个名字。
 * 命中关键字的角色按顺序取首个非空，未命中则取全部角色的首个非空。
 */
const OWNER_ROLE_PRIORITY = ['研发', '开发', '产品', '测试', 'PM', 'RD', 'QA']

function pickOwnerNames(roles: RoleEntry[] | undefined): string[] {
  if (!Array.isArray(roles) || roles.length === 0) return []
  const namedRoles = roles.filter(r => Array.isArray(r.members) && r.members.length > 0)

  for (const kw of OWNER_ROLE_PRIORITY) {
    const hit = namedRoles.find(r => typeof r.name === 'string' && r.name.includes(kw))
    if (hit && hit.members) {
      return Array.from(new Set(hit.members.map(m => m?.name).filter((n): n is string => !!n)))
    }
  }
  // 兜底：首个有人的角色
  const first = namedRoles[0]
  if (!first?.members) return []
  return Array.from(new Set(first.members.map(m => m?.name).filter((n): n is string => !!n)))
}

function normalizeMeegleWorkItems(
  items: WorkItem[] | undefined,
  ctx: { projectKey: string, workItemType: string },
): NormalizedViewItem[] {
  if (!Array.isArray(items)) return []
  const out: NormalizedViewItem[] = []
  for (const raw of items) {
    const attr = raw?.work_item_attribute
    if (!attr) continue
    const id = attr.work_item_id == null ? null : String(attr.work_item_id)
    if (!id) continue
    // 优先用工作项自身声明的 type.key，回退到 ctx 里用户填的 workItemType。
    const typeKey = attr.work_item_type?.key || ctx.workItemType
    out.push({
      id,
      title: typeof attr.work_item_name === 'string' ? attr.work_item_name : null,
      statusLabel: attr.work_item_status?.name ?? null,
      ownerNames: pickOwnerNames(attr.role_members),
      sourceUrl: `https://project.feishu.cn/${ctx.projectKey}/${typeKey}/detail/${id}`,
    })
  }
  return out
}

/**
 * 通过 `meegle view get` 拉取视图工作项列表。
 *
 * 与原 MCP 链路相比：
 * - 不依赖 MCP server 的"飞书项目 MCP"标记；
 * - 错误信息更直观（CLI 直接返回 `error.message`）；
 * - 鉴权由 `meegle auth status` 单独探测，不会在每次调用时报模糊错。
 */
export async function listViewItems(args: ListViewItemsArgs): Promise<ListViewItemsResult> {
  const projectKey = args.projectKey.trim()
  const workItemType = args.workItemType.trim()
  const viewId = args.viewId.trim()
  if (!projectKey || !workItemType || !viewId) {
    throw new Error('projectKey/workItemType/viewId 三者均必填')
  }
  const pageNum = Math.max(1, Number(args.pageNum) || 1)

  const cliArgs = [
    'view', 'get',
    '--view-id', viewId,
    '--project-key', projectKey,
    '--page-num', String(pageNum),
    '--format', 'json',
  ]

  const resp = await runMeegleCliJson<MeegleViewGetResponse>(cliArgs)

  if (resp?.error?.message) {
    throw new Error(`meegle view get 失败: ${resp.error.message}`)
  }

  const items = normalizeMeegleWorkItems(resp?.work_item_list, { projectKey, workItemType })
  const pagination = resp?.pagination ?? {}

  return {
    items,
    pageNum,
    hasMore: pagination.has_more === true,
    total: typeof pagination.total === 'number' ? pagination.total : null,
    rawSnippet: items.length === 0 && resp
      ? JSON.stringify(resp).slice(0, 800)
      : null,
  }
}
