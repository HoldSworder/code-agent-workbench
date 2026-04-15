import type { WorkflowTool, ToolInjectionContext, InjectedTool } from './types'
import { historyQueryTool } from './history-query.tool'

const tools: WorkflowTool[] = []

export function registerTool(tool: WorkflowTool): void {
  if (tools.some(t => t.id === tool.id)) return
  tools.push(tool)
}

export function getAllTools(): readonly WorkflowTool[] {
  return tools
}

export function collectTools(ctx: ToolInjectionContext): InjectedTool[] {
  const result: InjectedTool[] = []
  for (const tool of tools) {
    if (!tool.shouldInject(ctx)) continue
    const scriptPath = tool.resolveScript(ctx)
    if (!scriptPath) continue
    result.push({
      id: tool.id,
      promptSection: tool.getPromptSection(ctx, scriptPath),
    })
  }
  return result
}

registerTool(historyQueryTool)
