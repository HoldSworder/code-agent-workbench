/**
 * 解析飞书项目 MCP `tools/call` 返回的 result。
 *
 * MCP 协议返回 `{ content: [{ type: 'text', text: '<json-string>' }, ...], isError? }`。
 * 飞书项目 MCP 在第一个 text 内容里偶尔会塞 `log_id: ...` 前缀，需要跳过。
 *
 * 入参：已经是 body.result（feishu-project-mcp.ts callTool 返回值），不是完整 JSON-RPC 响应。
 */
export function extractMcpText(result: unknown): string | null {
  const r = result as { content?: Array<{ type?: string, text?: string }>, isError?: boolean } | null
  if (!r || !Array.isArray(r.content)) return null
  if (r.isError) return null
  for (const c of r.content) {
    if (c?.type === 'text' && typeof c.text === 'string' && !c.text.startsWith('log_id:') && !c.text.startsWith('logid:')) {
      return c.text
    }
  }
  return null
}

/** 解析 extractMcpText 的输出，失败时返回 null。 */
export function parseMcpJson<T = unknown>(result: unknown): T | null {
  const text = extractMcpText(result)
  if (!text) return null
  try { return JSON.parse(text) as T }
  catch { return null }
}

export interface NormalizedViewItem {
  id: string
  title: string | null
  statusLabel: string | null
  ownerNames: string[]
  sourceUrl: string
}

interface FeishuRoleOwner { name?: string }
interface FeishuRoleEntry { owners?: FeishuRoleOwner[] }
interface FeishuFieldValueLabel { label?: string }
interface FeishuWorkflowInfo { field_value?: FeishuFieldValueLabel | string }
interface FeishuViewItemRaw {
  id?: number | string
  work_item_id?: number | string
  name?: string
  current_state?: string | FeishuFieldValueLabel
  _current_state?: string | FeishuFieldValueLabel
  workflow_infos?: FeishuWorkflowInfo[]
  role_owners?: FeishuRoleEntry[]
  current_owner?: { name?: string } | string
}

function pickStatusLabel(item: FeishuViewItemRaw): string | null {
  const candidates: unknown[] = [
    item.current_state,
    item._current_state,
    item.workflow_infos?.[0]?.field_value,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
    if (c && typeof c === 'object' && 'label' in (c as object)) {
      const l = (c as FeishuFieldValueLabel).label
      if (typeof l === 'string' && l.trim()) return l
    }
  }
  return null
}

function pickOwnerNames(item: FeishuViewItemRaw): string[] {
  const names: string[] = []
  if (Array.isArray(item.role_owners)) {
    for (const r of item.role_owners) {
      if (Array.isArray(r?.owners)) {
        for (const o of r.owners) {
          if (typeof o?.name === 'string' && o.name.trim()) names.push(o.name)
        }
      }
    }
  }
  if (typeof item.current_owner === 'string' && item.current_owner.trim()) {
    names.push(item.current_owner)
  } else if (item.current_owner && typeof item.current_owner === 'object' && typeof item.current_owner.name === 'string') {
    names.push(item.current_owner.name)
  }
  return Array.from(new Set(names))
}

function pickId(item: FeishuViewItemRaw): string | null {
  const raw = item.work_item_id ?? item.id
  if (raw == null) return null
  return String(raw)
}

/**
 * 把飞书 get_view_detail 返回里的 list[]/items[] 标准化为前端可直接渲染的最小结构。
 * 找不到的字段填 null/空数组，不抛错。
 */
export function normalizeViewItems(
  parsedJson: unknown,
  ctx: { projectKey: string, workItemType: string },
): NormalizedViewItem[] {
  const root = (parsedJson ?? {}) as { list?: unknown[], items?: unknown[], data?: { list?: unknown[] } }
  const rawList: unknown[] = Array.isArray(root.list)
    ? root.list
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.data?.list)
        ? (root.data!.list as unknown[])
        : []

  const out: NormalizedViewItem[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as FeishuViewItemRaw
    const id = pickId(item)
    if (!id) continue
    out.push({
      id,
      title: typeof item.name === 'string' ? item.name : null,
      statusLabel: pickStatusLabel(item),
      ownerNames: pickOwnerNames(item),
      sourceUrl: `https://project.feishu.cn/${ctx.projectKey}/${ctx.workItemType}/detail/${id}`,
    })
  }
  return out
}

/** markdown 表头列名 → 标准字段。覆盖飞书项目 MCP 常见中英文列。 */
const HEADER_ALIAS: Record<string, 'id' | 'title' | 'status' | 'owner'> = {
  '工作项 id': 'id',
  '工作项id': 'id',
  'id': 'id',
  '名称': 'title',
  '标题': 'title',
  'name': 'title',
  'title': 'title',
  '状态': 'status',
  'status': 'status',
  '负责人': 'owner',
  '当前负责人': 'owner',
  'owner': 'owner',
  'assignee': 'owner',
}

function normHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, '')
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c))
}

/**
 * 解析飞书项目 MCP `get_view_detail` 偶尔返回的 markdown 表格。
 * 表头通常包含「工作项 ID」「名称」，可能也有「状态」「负责人」。
 * 失败返回空数组，不抛错。
 */
export function parseMarkdownTableItems(
  rawText: string | null,
  ctx: { projectKey: string, workItemType: string },
): NormalizedViewItem[] {
  if (!rawText) return []
  const lines = rawText.split(/\r?\n/)
  const tableLines: string[] = []
  for (const ln of lines) {
    const t = ln.trim()
    if (t.startsWith('|') && t.endsWith('|') && t.length >= 3) tableLines.push(t)
  }
  if (tableLines.length < 2) return []

  // 找第一段连续 `|...|` 的表，且第二行是分隔行
  let headerIdx = -1
  for (let i = 0; i < tableLines.length - 1; i++) {
    if (isSeparatorRow(splitTableRow(tableLines[i + 1]))) { headerIdx = i; break }
  }
  if (headerIdx < 0) return []

  const headers = splitTableRow(tableLines[headerIdx]).map(normHeaderCell)
  const colMap: Partial<Record<'id' | 'title' | 'status' | 'owner', number>> = {}
  headers.forEach((h, i) => {
    const key = HEADER_ALIAS[h]
    if (key && colMap[key] === undefined) colMap[key] = i
  })
  if (colMap.id === undefined) return []

  const out: NormalizedViewItem[] = []
  for (let i = headerIdx + 2; i < tableLines.length; i++) {
    const cells = splitTableRow(tableLines[i])
    if (isSeparatorRow(cells)) continue
    const idRaw = cells[colMap.id]?.trim()
    if (!idRaw) continue
    // 容忍尾部不完整行（截断时偶发）；ID 必须是数字或类数字
    if (!/^\d+$/.test(idRaw)) continue
    out.push({
      id: idRaw,
      title: colMap.title !== undefined ? (cells[colMap.title]?.trim() || null) : null,
      statusLabel: colMap.status !== undefined ? (cells[colMap.status]?.trim() || null) : null,
      ownerNames: colMap.owner !== undefined && cells[colMap.owner]
        ? cells[colMap.owner]!.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
        : [],
      sourceUrl: `https://project.feishu.cn/${ctx.projectKey}/${ctx.workItemType}/detail/${idRaw}`,
    })
  }
  return out
}
