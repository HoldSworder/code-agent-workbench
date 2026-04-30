import type { AgentRuntimeSettings } from '../providers/factory'
import { summarizeRepo, formatContextForPrompt } from './code-context'
import { llmCall } from './llm'
import type { RequirementSource } from './feishu-requirement'

export interface RepoRef {
  path: string
  alias?: string
  entryFiles?: string[]
}

export interface GenerateFrontendDesignInput {
  /** 来自飞书项目 MCP 解析得到的需求来源；包含 title / sourceType / docUrl / content。 */
  requirementSource: RequirementSource
  /** 关联仓库；用于注入代码库上下文。仅前端仓库即可。 */
  relatedRepos: RepoRef[]
  /** 已有 design.md 草稿；存在时按"增量补充"语义注入，避免覆盖人工修改。 */
  existingDesign?: string
  /** 设置中的 LLM runtime（CLI provider 或 custom-api）。 */
  runtime: AgentRuntimeSettings
  /** CLI 子进程 cwd；通常传第一个 relatedRepo 的 path，方便 cli 工具理解上下文。 */
  cwd?: string
}

/**
 * 「混合 design.md」的 system prompt：保留 OpenSpec design.md 的技术深度，
 * 但合并 proposal.md 的 Why / Scope，从而一篇文档即可作为 plan 会议评审材料。
 *
 * 重点约束：
 * 1. 仅前端视角。后端 / SQL / DDL / 服务端鉴权一律不展开，必要时只在「外部依赖」一两句话提及。
 * 2. Capabilities 章节列出后续可拆分为 specs/<capability>/spec.md 的能力清单；不在本文档展开 ADDED Requirements / scenario 详尽语法。
 * 3. 严禁编造接口；代码上下文里没找到的 API 一律标 `TBD` 并放到「待澄清问题」。
 */
const SYSTEM_PROMPT = `你是高级前端架构师。任务：基于产品需求与前端代码上下文，输出一份"前端开发 design.md"，用于 plan 会议评审与故事点评估。

# 文档结构（严格使用以下一级标题，按顺序输出）

\`\`\`
# 前端开发设计 - {{需求标题}}

## Why
- 问题陈述（1-3 句）
- 业务收益与受众

## Scope
### In Scope
- 仅列前端能交付的能力（页面/组件/交互/接入/埋点等）

### Out of Scope
- 显式排除：后端实现、跨端、SDK 改动等

## 技术方案
### 整体架构
- 数据流向（用户操作 → 组件 → store/composable → API/SDK → UI 反馈）
- 关键模块拆分与职责
- 复用既有组件 / 路由 / 状态的具体名字（必须出现在代码上下文里，否则标 TBD）

### 关键交互
- 列出 2~5 个核心用户场景，每个含触发、状态变化、UI 反馈、异常分支

### 接口契约
- 仅列前端要消费的接口清单：方法 + path + 入参/出参字段（来自代码上下文，不得编造，否则标 TBD）
- 状态码 / 错误码处理策略

### 状态与缓存
- 全局状态、本地缓存、URL 参数、轮询 / SSE / WebSocket 等的取舍

## Capabilities（后续 spec 拆分用）
- 列 3~8 条能力，每条 1 行：\`<capability-key>: <一句话能力描述>\`
- 命名用 kebab-case，便于后续按 specs/<capability>/spec.md 切分
- 本文档不展开 OpenSpec 的 ADDED/MODIFIED Requirements / WHEN/THEN scenario，保留给后续 spec.md

## 影响面
- 改动到的页面 / 组件 / 公共模块（基于代码上下文，列具体路径）
- 新增 / 升级的依赖包

## 风险
- 可能踩的坑、性能 / 可访问性 / 兼容性 / 埋点回归点

## 待澄清问题
- 用任务列表 \`- [ ] 描述\`，列产品 / 后端 / 设计需要回答的问题

\`\`\`

# 输出与质量约束

1. 文档必须仅围绕"前端"。出现"数据库 schema / SQL / 后端服务 / DDL"等字眼即视为越界，应当移到"外部依赖"一句话简述或"待澄清问题"。
2. 严禁编造 API、组件名、路由、字段名。代码上下文未出现的，一律标 \`TBD\` 并加到"待澄清问题"。
3. 输出纯 Markdown，不要再用代码围栏整体包裹。
4. 若提供了"已有 design.md 草稿"，按增量补充语义工作：保留人工已有结论，仅补缺失章节、修订矛盾点；不得无依据重写。
5. 对需求来源中的关键信息要做引用：原文出现的字段名 / 状态 / 角色 / 数字必须在 design 中能溯源，不要二次抽象到模糊词。
`.trim()

function describeSourceType(source: RequirementSource): string {
  switch (source.sourceType) {
    case 'spec_doc':
      return `飞书项目「需求SPEC文档」字段：${source.sourceFieldLabel ?? '需求SPEC文档'}（已抓取正文）`
    case 'requirement_doc':
      return `飞书项目「需求文档」字段：${source.sourceFieldLabel ?? '需求文档'}（已抓取正文）`
    case 'description':
      return `飞书项目「描述」字段：${source.sourceFieldLabel ?? '描述'}`
    case 'title_only':
      return '未在飞书工作项找到 SPEC文档/需求文档/描述，仅有标题可用'
  }
}

export async function generateFrontendDesign(input: GenerateFrontendDesignInput): Promise<string> {
  const repoSummaries: string[] = []
  for (const r of input.relatedRepos) {
    const ctx = await summarizeRepo({ repoPath: r.path, entryFiles: r.entryFiles })
    repoSummaries.push(`## 仓库：${r.alias ?? r.path}\n\n${formatContextForPrompt(ctx)}`)
  }

  const { requirementSource } = input
  const requirementBlock = requirementSource.content
    ? `# 需求文档原文（来源：${describeSourceType(requirementSource)}）\n\n${requirementSource.content}`
    : `# 需求文档原文\n\n（${describeSourceType(requirementSource)}）`

  const warningsBlock = requirementSource.warnings.length
    ? `# 需求采集过程中的警告\n${requirementSource.warnings.map(w => `- ${w}`).join('\n')}`
    : ''

  const userPrompt = [
    `# 需求标题\n${requirementSource.title}`,
    `# 飞书工作项链接\n${requirementSource.workItemUrl}`,
    requirementBlock,
    warningsBlock,
    repoSummaries.length ? `# 关联前端代码库上下文\n\n${repoSummaries.join('\n\n---\n\n')}` : '# 关联前端代码库上下文\n\n（无）',
    input.existingDesign ? `# 已有 design.md 草稿\n\n${input.existingDesign}\n\n请按"增量补充"语义工作：保留人工结论，补缺失章节、修订矛盾点。` : '',
  ].filter(Boolean).join('\n\n---\n\n')

  return llmCall({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 6000,
    runtime: input.runtime,
    cwd: input.cwd,
  })
}
