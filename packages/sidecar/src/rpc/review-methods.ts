import type Database from 'better-sqlite3'
import { errorMessage } from '@code-agent/shared/util'
import { getLarkAuthStatus } from '@code-agent/shared/lark'
import type { LarkIdentityResult } from '@code-agent/shared/lark'
import type { RpcServer } from './server'
import { McpServerRepository } from '../db/repositories/mcp-server.repo'
import { FeishuProjectMcpClient } from '../review/feishu-project-mcp'
import * as feishuDoc from '../review/feishu-doc'
import { generateDevSpec } from '../review/spec-generator'
import { evaluateStoryPoints, formatAssessmentMarkdown, type RoleResult } from '../review/story-point-evaluator'
import { ReviewServerClient } from '../review/client'
import { extractMcpText, normalizeViewItems, parseMarkdownTableItems, parseMcpJson, type NormalizedViewItem } from '../review/mcp-text'

export type { LarkIdentityResult }

interface CallerIdentityArg {
  userId: string
  userName: string
  role?: string
}

/**
 * 通过 lark-cli auth status 校验飞书登录身份。
 * 桌面端进入评审视图前调用，作为强制前置依赖之一。
 *
 * 实现已下沉到 `@code-agent/shared/lark`，这里仅作为 RPC 入口透传。
 */
async function checkLarkIdentity(): Promise<LarkIdentityResult> {
  return getLarkAuthStatus()
}

export function registerReviewMethods(server: RpcServer, db: Database.Database): void {
  const mcpServerRepo = new McpServerRepository(db)
  const feishuMcp = new FeishuProjectMcpClient(mcpServerRepo)

  server.register('review.checkLarkIdentity', async () => checkLarkIdentity())

  server.register('review.checkFeishuProjectMcp', async () => feishuMcp.checkStatus())

  server.register('review.feishuProjectMcpCall', async ({ tool, args }: { tool: string, args?: Record<string, unknown> }) => {
    const result = await feishuMcp.callTool(tool, args ?? {})
    return { result }
  })

  /**
   * 拉取飞书项目视图下的工作项列表，标准化后返回，供「评审入口」选择需求。
   * - 不缓存、不持久化，每次实时调用 MCP。
   * - 入参 viewId 是飞书侧的视图 ID，projectKey/workItemType 用于拼回详情链接。
   * - 工具名按关键字 `get_view_detail` 在 tools/list 里动态匹配，兼容不同 MCP 部署的命名。
   * - 当解析不出条目时回传 debug 字段（实际工具名 + 原始响应摘要），便于前端排错。
   */
  server.register('review.listViewWorkItems', async (params: {
    projectKey: string
    workItemType: string
    viewId: string
    pageNum?: number
    pageSize?: number
  }): Promise<{
    items: NormalizedViewItem[]
    pageNum: number
    pageSize: number
    toolName: string
    debug?: { availableTools: string[], rawSnippet: string | null }
  }> => {
    const projectKey = params.projectKey?.trim()
    const workItemType = params.workItemType?.trim()
    const viewId = params.viewId?.trim()
    if (!projectKey || !workItemType || !viewId)
      throw new Error('projectKey/workItemType/viewId 三者均必填')

    const pageNum = Math.max(1, Number(params.pageNum) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50))

    const allTools = await feishuMcp.listToolNames()
    const toolName = allTools.find(n => /(^|[-_/])get_view_detail$/i.test(n))
      ?? allTools.find(n => n.toLowerCase().includes('get_view_detail'))
    if (!toolName) {
      throw new Error(
        `飞书项目 MCP 未暴露 get_view_detail 工具。可用工具：${allTools.join(', ') || '（空）'}`,
      )
    }

    const result = await feishuMcp.callTool(toolName, {
      view_id: viewId,
      project_key: projectKey,
      page_num: pageNum,
      page_size: pageSize,
    })
    const rawText = extractMcpText(result)

    // 飞书项目 MCP 既可能返回 JSON 文本（list/items/data.list），也可能返回 markdown 表格。
    // 先按 JSON 路径，再回退到 markdown 表格解析。
    let items = normalizeViewItems(parseMcpJson(result), { projectKey, workItemType })
    if (items.length === 0)
      items = parseMarkdownTableItems(rawText, { projectKey, workItemType })

    if (items.length === 0) {
      return {
        items,
        pageNum,
        pageSize,
        toolName,
        debug: {
          availableTools: allTools,
          rawSnippet: rawText ? rawText.slice(0, 800) : null,
        },
      }
    }

    return { items, pageNum, pageSize, toolName }
  })

  // ── 飞书云文档（lark-cli 包装） ──
  server.register('review.feishuDocCreate', async (params: { title: string, content: string, folderToken?: string }) => {
    return feishuDoc.createDoc({ title: params.title, content: params.content, folderToken: params.folderToken })
  })
  server.register('review.feishuDocFetch', async ({ tokenOrUrl }: { tokenOrUrl: string }) => {
    return { content: await feishuDoc.fetchDoc(tokenOrUrl) }
  })
  server.register('review.feishuDocOverwrite', async ({ tokenOrUrl, content }: { tokenOrUrl: string, content: string }) => {
    await feishuDoc.overwriteDoc(tokenOrUrl, content)
    return { ok: true }
  })
  server.register('review.feishuDocAppend', async ({ tokenOrUrl, content }: { tokenOrUrl: string, content: string }) => {
    await feishuDoc.appendDoc(tokenOrUrl, content)
    return { ok: true }
  })

  // ── AI 生成 dev-spec ──
  server.register('review.generateDevSpec', async (params: {
    sessionId: string
    requirementTitle: string
    requirementMarkdown: string
    relatedRepos: Array<{ path: string, alias?: string, entryFiles?: string[] }>
    existingSpec?: string
    reviewServerBaseUrl?: string
    identity?: CallerIdentityArg
  }) => {
    const content = await generateDevSpec({
      requirementTitle: params.requirementTitle,
      requirementMarkdown: params.requirementMarkdown,
      relatedRepos: params.relatedRepos,
      existingSpec: params.existingSpec,
    })

    let upserted: { content: string, version: number, conflict: boolean } | null = null
    if (params.reviewServerBaseUrl && params.identity) {
      const client = new ReviewServerClient(params.reviewServerBaseUrl)
      try {
        upserted = await client.upsertSpec(params.identity, params.sessionId, { content, force: true })
      }
      catch (err) {
        const msg = errorMessage(err)
        return { content, error: `已生成内容，但同步评审中心失败: ${msg}` }
      }
    }

    return { content, upserted }
  })

  // ── AI 评估故事点 + 写回飞书 + 透传 review-server ──
  server.register('review.evaluateStoryPoints', async (params: {
    sessionId: string
    requirementTitle: string
    specMarkdown: string
    rulesFilePath?: string
    cwd?: string
    feishuSpecDocTokenOrUrl?: string
    /** 写回飞书项目工作项时使用：{tool, requirementId, fieldMap} */
    writebackPlan?: {
      tool: string
      requirementId: string | number
      fields: Array<{ fieldKey: string, role: RoleResult['role'] }>
    }
    reviewServerBaseUrl?: string
    identity?: CallerIdentityArg
  }) => {
    const results = await evaluateStoryPoints({
      requirementTitle: params.requirementTitle,
      specMarkdown: params.specMarkdown,
      rulesFilePath: params.rulesFilePath,
      cwd: params.cwd,
    })

    const warnings: string[] = []

    if (params.feishuSpecDocTokenOrUrl) {
      try {
        await feishuDoc.appendDoc(params.feishuSpecDocTokenOrUrl, `\n\n---\n\n${formatAssessmentMarkdown(results)}\n`)
      }
      catch (err) {
        warnings.push(`追加飞书文档失败: ${errorMessage(err)}`)
      }
    }

    if (params.writebackPlan) {
      const byRole = new Map<RoleResult['role'], number>(results.map(r => [r.role, r.points]))
      for (const f of params.writebackPlan.fields) {
        const points = byRole.get(f.role)
        if (points == null) continue
        try {
          await feishuMcp.callTool(params.writebackPlan.tool, {
            workItemId: params.writebackPlan.requirementId,
            fieldKey: f.fieldKey,
            value: points,
          })
        }
        catch (err) {
          warnings.push(`回写字段 ${f.fieldKey} 失败: ${errorMessage(err)}`)
        }
      }
    }

    if (params.reviewServerBaseUrl && params.identity) {
      try {
        const client = new ReviewServerClient(params.reviewServerBaseUrl)
        await client.submitAssessmentResults(params.identity, params.sessionId, results)
      }
      catch (err) {
        warnings.push(`提交到评审中心失败: ${errorMessage(err)}`)
      }
    }

    return { results, warnings }
  })

  // ── review-server 健康探测 ──
  server.register('review.serverHealth', async ({ baseUrl }: { baseUrl: string }) => {
    try {
      const client = new ReviewServerClient(baseUrl)
      const r = await client.health()
      return { healthy: !!r?.ok, error: null }
    }
    catch (err) {
      return { healthy: false, error: errorMessage(err) }
    }
  })

  /**
   * 评审会话列表（透传 review-server GET /api/sessions）。
   * 前端改走 sidecar 中转，统一异常翻译，避免在 Tauri WKWebView 下 fetch 失败时只有 "Type error"。
   */
  server.register('review.listSessions', async ({ baseUrl }: { baseUrl: string }) => {
    const client = new ReviewServerClient(baseUrl)
    return client.listSessions()
  })

  /**
   * 创建（或复用）评审会话（透传 review-server POST /api/sessions）。
   * identity 必传；写入 X-Lark-User-* 头由 ReviewServerClient 内部处理。
   */
  server.register('review.createSession', async (params: {
    baseUrl: string
    identity: CallerIdentityArg
    input: {
      requirementId: string
      requirementTitle: string
      feishuRequirementUrl?: string
      feishuSpecDocToken?: string
      feishuSpecDocUrl?: string
      initialSpecMarkdown?: string
      relatedRepos?: string[]
    }
  }) => {
    const client = new ReviewServerClient(params.baseUrl)
    return client.createSession(params.identity, params.input)
  })
}
