import { summarizeRepo, formatContextForPrompt } from './code-context'
import { llmCall } from './llm'

export interface RepoRef {
  path: string
  alias?: string
  entryFiles?: string[]
}

export interface GenerateDevSpecInput {
  requirementTitle: string
  requirementMarkdown: string
  relatedRepos: RepoRef[]
  /** 已有的 dev-spec 草稿；存在时让 LLM 增量补充而非重写。 */
  existingSpec?: string
}

const SYSTEM_PROMPT = `你是高级软件评审专家。任务：基于产品需求与代码上下文，输出"开发 Spec"（dev-spec）的 Markdown。
要求：
1. 顶层使用一级标题"开发 Spec"
2. 必含章节：背景与目标、影响范围、前端方案、后端方案、数据/接口契约、风险与依赖、待澄清问题
3. 章节中的"待澄清问题"使用任务列表（- [ ] 描述），便于参与者勾选
4. 不要编造 API 接口名；如代码中无对应实现，标注 "TBD"
5. 输出仅包含 Markdown，不要再包一层代码围栏`.trim()

export async function generateDevSpec(input: GenerateDevSpecInput): Promise<string> {
  const repoSummaries: string[] = []
  for (const r of input.relatedRepos) {
    const ctx = await summarizeRepo({ repoPath: r.path, entryFiles: r.entryFiles })
    repoSummaries.push(`## 仓库：${r.alias ?? r.path}\n\n${formatContextForPrompt(ctx)}`)
  }

  const userPrompt = [
    `# 需求标题\n${input.requirementTitle}`,
    `# 需求 Spec（产品文档原文）\n\n${input.requirementMarkdown}`,
    repoSummaries.length ? `# 关联代码库上下文\n\n${repoSummaries.join('\n\n---\n\n')}` : '# 关联代码库上下文\n\n（无）',
    input.existingSpec ? `# 已有的 dev-spec 草稿\n\n${input.existingSpec}\n\n请在此基础上补充完善。` : '',
  ].filter(Boolean).join('\n\n---\n\n')

  return llmCall({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 6000,
  })
}
