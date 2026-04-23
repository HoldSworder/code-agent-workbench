export interface WorkflowSkillInput {
  key: string
  label?: string
  required?: boolean
  default?: string
}

export interface WorkflowSkillMeta {
  id: string
  name: string
  description: string
  inputs?: WorkflowSkillInput[]
  mcp_dependencies?: string[]
  tags?: string[]
}

export interface WorkflowSkill {
  meta: WorkflowSkillMeta
  /** SKILL.md 原始内容（未插值） */
  content: string
  /** 目录绝对路径 */
  dir: string
}

export interface RenderedWorkflowSkill {
  id: string
  meta: WorkflowSkillMeta
  /** 完成 {{var}} 插值后的 prompt 正文 */
  content: string
  missingVars: string[]
}
