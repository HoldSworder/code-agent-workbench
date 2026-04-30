import type Database from 'better-sqlite3'
import { errorMessage } from '@code-agent/shared/util'
import { getLarkAuthStatus } from '@code-agent/shared/lark'
import type { LarkIdentityResult } from '@code-agent/shared/lark'
import type { RpcServer } from './server'
import { McpServerRepository } from '../db/repositories/mcp-server.repo'
import { SettingsRepository } from '../db/repositories/settings.repo'
import { FeishuProjectMcpClient } from '../review/feishu-project-mcp'
import * as feishuDoc from '../review/feishu-doc'
import { generateFrontendDesign } from '../review/design-generator'
import { resolveRequirementDoc, type RequirementSource } from '../review/feishu-requirement'
import { evaluateStoryPoints, formatAssessmentMarkdown, type RoleResult } from '../review/story-point-evaluator'
import { ReviewServerClient } from '../review/client'
import { extractMcpText, normalizeViewItems, parseMarkdownTableItems, parseMcpJson, type NormalizedViewItem } from '../review/mcp-text'
import { detectStoryPointFields, flattenFieldList, type DetectStoryPointFieldsResult, type StoryPointFieldRef } from '../review/story-point-detector'
import { isCliProvider, loadAgentRuntimeFromSettings, type AgentRuntimeSettings } from '../providers/factory'

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
  const settingsRepo = new SettingsRepository(db)
  const feishuMcp = new FeishuProjectMcpClient(mcpServerRepo)

  /**
   * 实时从设置解析 LLM runtime（CLI provider 或 custom-api），避免 sidecar 启动后无法热更新。
   * 返回值传给 review LLM 流程（design 生成 / 故事点评估）。
   */
  function resolveLlmRuntime(): AgentRuntimeSettings {
    return loadAgentRuntimeFromSettings(settingsRepo)
  }

  /**
   * 双分支前置校验：
   * - custom-api：必须配置 apiKey，否则提示去设置页填；
   * - CLI provider：runCliSingleShot 自身会兜底报「CLI 未在 PATH」错误，这里不强制校验，
   *   避免重复 spawn 一次纯探测请求。
   */
  function assertLlmConfigured(rt: AgentRuntimeSettings): void {
    if (rt.provider === 'custom-api' && !rt.apiKey) {
      throw new Error('当前 agent.provider 为 custom-api，请到桌面端「设置」页填写 agent.apiKey 后重试。')
    }
    if (!isCliProvider(rt.provider) && rt.provider !== 'custom-api') {
      throw new Error(`未识别的 agent.provider：${String(rt.provider)}；请在桌面端「设置」页选择 cursor-cli/claude-code/codex 或 custom-api。`)
    }
  }

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

  // ── 飞书项目 → 需求来源解析（按 SPEC文档 → 需求文档 → 描述 优先级） ──
  server.register('review.fetchRequirementDoc', async (params: {
    workItemUrl: string
  }): Promise<RequirementSource> => {
    if (!params.workItemUrl?.trim())
      throw new Error('workItemUrl 必填')
    return resolveRequirementDoc({
      feishuMcp,
      workItemUrl: params.workItemUrl.trim(),
    })
  })

  // ── AI 生成前端 design.md（混合 proposal + design 视角） ──
  server.register('review.generateFrontendDesign', async (params: {
    sessionId: string
    requirementSource: RequirementSource
    relatedRepos: Array<{ path: string, alias?: string, entryFiles?: string[] }>
    existingDesign?: string
    /** CLI 子进程 cwd；不传时取第一个 relatedRepos.path。 */
    cwd?: string
    reviewServerBaseUrl?: string
    identity?: CallerIdentityArg
  }) => {
    const runtime = resolveLlmRuntime()
    assertLlmConfigured(runtime)

    const cwd = params.cwd?.trim() || params.relatedRepos[0]?.path
    const content = await generateFrontendDesign({
      requirementSource: params.requirementSource,
      relatedRepos: params.relatedRepos,
      existingDesign: params.existingDesign,
      runtime,
      cwd,
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
    const runtime = resolveLlmRuntime()
    assertLlmConfigured(runtime)
    const results = await evaluateStoryPoints({
      requirementTitle: params.requirementTitle,
      specMarkdown: params.specMarkdown,
      rulesFilePath: params.rulesFilePath,
      cwd: params.cwd,
      runtime,
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

  // ── 故事点字段自动探测 + 持久化（按 projectKey 维度） ──

  /**
   * 调用飞书项目 MCP `list_workitem_field_config` 获取工作项类型的字段清单，
   * 按命名约定匹配前端 / 后端 / 测试故事点 field_key。
   *
   * 返回：
   * - 三个角色各自匹配结果（命中或 null）
   * - allFields：完整字段清单（探测失败时供 UI 让用户挑选 / 兜底）
   *
   * 不写库；持久化由 review.upsertStoryPointFields 完成。
   */
  server.register('review.detectStoryPointFields', async (params: {
    projectKey: string
    workItemType: string
  }): Promise<DetectStoryPointFieldsResult & { writebackTool: 'update_field' }> => {
    const projectKey = params.projectKey?.trim()
    const workItemType = params.workItemType?.trim()
    if (!projectKey) throw new Error('projectKey 必填')
    if (!workItemType) throw new Error('workItemType 必填')

    const allTools = await feishuMcp.listToolNames()
    const toolName = allTools.find(n => /(^|[-_/])list_workitem_field_config$/i.test(n))
      ?? allTools.find(n => n.toLowerCase().includes('list_workitem_field_config'))
    if (!toolName) {
      throw new Error(`飞书项目 MCP 未提供 list_workitem_field_config 工具。已知工具：${allTools.slice(0, 20).join(', ')}`)
    }

    let allFields: StoryPointFieldRef[] = []
    let pageNum = 1
    while (pageNum <= 10) {
      const result = await feishuMcp.callTool(toolName, {
        project_key: projectKey,
        work_item_type: workItemType,
        page_num: pageNum,
      })
      const json = parseMcpJson<unknown>(result)
      const page = flattenFieldList(json)
      if (page.length === 0) break
      const seen = new Set(allFields.map(f => f.fieldKey))
      for (const f of page) if (!seen.has(f.fieldKey)) allFields.push(f)
      // 单页通常 50 条；不到 50 视为最后一页。
      if (page.length < 50) break
      pageNum += 1
    }

    const matched = detectStoryPointFields(allFields)
    return { ...matched, writebackTool: 'update_field' }
  })

  /** 读取按 projectKey 持久化的故事点字段配置（manual 优先于 auto）。 */
  server.register('review.getStoryPointFields', async (params: { projectKey: string }): Promise<{
    frontend: StoryPointFieldRef | null
    backend: StoryPointFieldRef | null
    qa: StoryPointFieldRef | null
    writebackTool: string
    source: 'manual' | 'auto' | null
    updatedAt: string | null
  }> => {
    const projectKey = params.projectKey?.trim()
    if (!projectKey) throw new Error('projectKey 必填')
    const raw = settingsRepo.get(`review.storyPointFields:${projectKey}`)
    if (!raw) {
      return { frontend: null, backend: null, qa: null, writebackTool: 'update_field', source: null, updatedAt: null }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<{
        frontend: StoryPointFieldRef | null
        backend: StoryPointFieldRef | null
        qa: StoryPointFieldRef | null
        writebackTool: string
        source: 'manual' | 'auto'
        updatedAt: string
      }>
      return {
        frontend: parsed.frontend ?? null,
        backend: parsed.backend ?? null,
        qa: parsed.qa ?? null,
        writebackTool: parsed.writebackTool ?? 'update_field',
        source: parsed.source ?? null,
        updatedAt: parsed.updatedAt ?? null,
      }
    }
    catch {
      // 损坏数据视为空，下一次 upsert 会覆盖。
      return { frontend: null, backend: null, qa: null, writebackTool: 'update_field', source: null, updatedAt: null }
    }
  })

  /** 写入故事点字段配置。source 区分用户手动覆盖 vs MCP 自动探测。 */
  server.register('review.upsertStoryPointFields', async (params: {
    projectKey: string
    frontend: StoryPointFieldRef | null
    backend: StoryPointFieldRef | null
    qa: StoryPointFieldRef | null
    writebackTool?: string
    source: 'manual' | 'auto'
  }): Promise<{ ok: true }> => {
    const projectKey = params.projectKey?.trim()
    if (!projectKey) throw new Error('projectKey 必填')
    if (params.source !== 'manual' && params.source !== 'auto')
      throw new Error('source 必须为 manual 或 auto')

    const payload = {
      frontend: params.frontend,
      backend: params.backend,
      qa: params.qa,
      writebackTool: params.writebackTool || 'update_field',
      source: params.source,
      updatedAt: new Date().toISOString(),
    }
    settingsRepo.set(`review.storyPointFields:${projectKey}`, JSON.stringify(payload))
    return { ok: true }
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
