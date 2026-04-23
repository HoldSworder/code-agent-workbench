import { basename, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import type { WorkflowTool, ToolInjectionContext, InjectedTool } from './types'
import { historyQueryTool } from './history-query.tool'
import { inspectLogsTool } from './inspect-logs.tool'
import { taskProgressTool } from './task-progress.tool'
import { phaseSignalTool } from './phase-signal.tool'
import { gateStatusTool } from './gate-status.tool'
import { openspecQueryTool } from './openspec-query.tool'
import { taskChecklistTool } from './task-checklist.tool'
import { workflowNavTool } from './workflow-nav.tool'
import { repoInfoTool } from './repo-info.tool'
import { uiElementTool } from './ui-element.tool'

const tools: WorkflowTool[] = []

export function registerTool(tool: WorkflowTool): void {
  if (tools.some(t => t.id === tool.id)) return
  tools.push(tool)
}

export function getAllTools(): readonly WorkflowTool[] {
  return tools
}

/**
 * Copy a tool script into the worktree so that sandboxed agents (e.g. Cursor
 * CLI) whose allowed-directories are limited to the worktree can still execute
 * them.  Returns the worktree-local path.
 */
function syncScriptToWorktree(toolId: string, srcPath: string, worktreePath: string): string {
  const scriptName = basename(srcPath)
  const destDir = join(worktreePath, '.code-agent', 'tools', toolId)
  const destPath = join(destDir, scriptName)
  try {
    if (!existsSync(destDir))
      mkdirSync(destDir, { recursive: true })
    copyFileSync(srcPath, destPath)
  }
  catch {
    return srcPath
  }
  return destPath
}

export function collectTools(ctx: ToolInjectionContext): InjectedTool[] {
  const result: InjectedTool[] = []
  for (const tool of tools) {
    if (!tool.shouldInject(ctx)) continue
    const scriptPath = tool.resolveScript(ctx)
    if (!scriptPath) continue
    const localPath = syncScriptToWorktree(tool.id, scriptPath, ctx.worktreePath)
    result.push({
      id: tool.id,
      promptSection: tool.getPromptSection(ctx, localPath),
    })
  }
  return result
}

registerTool(historyQueryTool)
registerTool(inspectLogsTool)
registerTool(taskProgressTool)
registerTool(phaseSignalTool)
registerTool(gateStatusTool)
registerTool(openspecQueryTool)
registerTool(taskChecklistTool)
registerTool(workflowNavTool)
registerTool(repoInfoTool)
registerTool(uiElementTool)
