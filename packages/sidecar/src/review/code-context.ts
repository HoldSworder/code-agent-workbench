import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { errorMessage } from '@code-agent/shared/util'
import { git } from '../git/operations'

interface ContextOptions {
  repoPath: string
  /** 关注的入口文件相对路径（最多取前 N 个） */
  entryFiles?: string[]
  maxBytesPerFile?: number
  maxFiles?: number
}

interface CodeContext {
  repoPath: string
  branch: string
  recentCommits: string[]
  fileTree: string[]
  fileSnippets: Array<{ path: string, content: string }>
  warnings: string[]
}

async function safeGit(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args, 15_000)
  }
  catch {
    return ''
  }
}

export async function summarizeRepo(opts: ContextOptions): Promise<CodeContext> {
  const warnings: string[] = []

  let exists = false
  try {
    const s = await stat(opts.repoPath)
    exists = s.isDirectory()
  }
  catch {}
  if (!exists) {
    warnings.push(`仓库路径不存在: ${opts.repoPath}`)
    return { repoPath: opts.repoPath, branch: '', recentCommits: [], fileTree: [], fileSnippets: [], warnings }
  }

  const branch = (await safeGit(opts.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])) || '(detached)'
  const recentCommits = (await safeGit(
    opts.repoPath,
    ['log', '--oneline', '--no-merges', '-n', '15'],
  )).split('\n').filter(Boolean)

  let fileTree: string[] = []
  const lsTree = await safeGit(opts.repoPath, ['ls-files'])
  if (lsTree) {
    fileTree = lsTree.split('\n')
      .filter(line => line && !line.includes('node_modules') && !line.includes('dist/') && !line.includes('.git/'))
      .slice(0, opts.maxFiles ?? 200)
  }
  else {
    warnings.push('git ls-files 失败，未能枚举文件列表')
  }

  const maxBytes = opts.maxBytesPerFile ?? 6000
  const fileSnippets: Array<{ path: string, content: string }> = []
  const entry = opts.entryFiles?.slice(0, 8) ?? []
  for (const rel of entry) {
    const abs = join(opts.repoPath, rel)
    try {
      const s = await stat(abs)
      if (!s.isFile()) continue
      const buf = await readFile(abs, 'utf-8')
      fileSnippets.push({
        path: relative(opts.repoPath, abs),
        content: buf.length > maxBytes ? `${buf.slice(0, maxBytes)}\n...(truncated)` : buf,
      })
    }
    catch (err) {
      warnings.push(`读取入口文件失败: ${rel} (${errorMessage(err)})`)
    }
  }

  return { repoPath: opts.repoPath, branch, recentCommits, fileTree, fileSnippets, warnings }
}

export function formatContextForPrompt(ctx: CodeContext): string {
  const lines: string[] = []
  lines.push(`# 仓库: ${ctx.repoPath}`)
  lines.push(`分支: ${ctx.branch}`)
  if (ctx.recentCommits.length) {
    lines.push('近 15 条提交:')
    for (const c of ctx.recentCommits) lines.push(`- ${c}`)
  }
  if (ctx.fileTree.length) {
    lines.push('\n文件列表（前 200 项）:')
    lines.push(ctx.fileTree.slice(0, 100).map(p => `- ${p}`).join('\n'))
  }
  if (ctx.fileSnippets.length) {
    lines.push('\n入口文件片段:')
    for (const f of ctx.fileSnippets) {
      lines.push(`\n## ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``)
    }
  }
  if (ctx.warnings.length) {
    lines.push('\n> 警告:')
    for (const w of ctx.warnings) lines.push(`> - ${w}`)
  }
  return lines.join('\n')
}
