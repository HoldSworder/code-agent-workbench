import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  await git(repoPath, ['fetch', 'origin', baseBranch])
  await git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, `origin/${baseBranch}`])
}

export async function createBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  await git(repoPath, ['checkout', baseBranch])
  await git(repoPath, ['pull', 'origin', baseBranch])
  await git(repoPath, ['checkout', '-b', branchName])
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', worktreePath, '--force'])
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(cwd, ['branch', '--show-current'])
}

export async function getHead(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD'])
}

export async function resetHard(cwd: string, commitSha: string): Promise<void> {
  await git(cwd, ['reset', '--hard', commitSha])
  await git(cwd, ['clean', '-fd'])
}

export async function getMergeBase(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['merge-base', 'HEAD', 'origin/main'])
  }
  catch {
    try { return await git(cwd, ['merge-base', 'HEAD', 'origin/master']) }
    catch { return null }
  }
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

/**
 * Get all changed files: committed changes (baseSha..HEAD) + uncommitted + untracked.
 * If baseSha is null, only show uncommitted + untracked working tree changes.
 */
export async function getChangedFiles(cwd: string, baseSha: string | null): Promise<ChangedFile[]> {
  const fileMap = new Map<string, ChangedFile>()

  if (baseSha) {
    const numstat = await git(cwd, ['diff', '--numstat', '--diff-filter=ADMR', baseSha, 'HEAD']).catch(() => '')
    const nameStatus = await git(cwd, ['diff', '--name-status', '--diff-filter=ADMR', baseSha, 'HEAD']).catch(() => '')

    const statusMap = new Map<string, string>()
    for (const line of nameStatus.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const code = parts[0]?.[0]
      const filePath = parts[parts.length - 1]
      if (code && filePath) statusMap.set(filePath, code)
    }

    for (const line of numstat.split('\n')) {
      if (!line) continue
      const [add, del, ...pathParts] = line.split('\t')
      const filePath = pathParts.join('\t')
      const statusCode = statusMap.get(filePath) ?? 'M'
      fileMap.set(filePath, {
        path: filePath,
        status: statusCode === 'A' ? 'added' : statusCode === 'D' ? 'deleted' : statusCode === 'R' ? 'renamed' : 'modified',
        additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
        deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      })
    }
  }

  const wcNumstat = await git(cwd, ['diff', '--numstat']).catch(() => '')
  for (const line of wcNumstat.split('\n')) {
    if (!line) continue
    const [add, del, ...pathParts] = line.split('\t')
    const filePath = pathParts.join('\t')
    if (fileMap.has(filePath)) continue
    fileMap.set(filePath, {
      path: filePath,
      status: 'modified',
      additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
    })
  }

  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
  for (const filePath of untracked.split('\n')) {
    if (!filePath || fileMap.has(filePath)) continue
    const lines = await countFileLines(cwd, filePath)
    fileMap.set(filePath, {
      path: filePath,
      status: 'added',
      additions: lines,
      deletions: 0,
    })
  }

  return Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path))
}

async function countFileLines(cwd: string, filePath: string): Promise<number> {
  try {
    const content = await exec('cat', [filePath], { cwd, encoding: 'utf8' })
    return content.stdout.split('\n').length
  }
  catch { return 0 }
}

/**
 * Get unified diff for a single file. Handles committed, unstaged, and untracked files.
 */
export async function getFileDiff(cwd: string, baseSha: string | null, filePath: string): Promise<string> {
  if (baseSha) {
    const committed = await git(cwd, ['diff', '--unified=5', baseSha, 'HEAD', '--', filePath]).catch(() => '')
    if (committed) return committed
  }

  const unstaged = await git(cwd, ['diff', '--unified=5', '--', filePath]).catch(() => '')
  if (unstaged) return unstaged

  try {
    const content = await exec('cat', [filePath], { cwd, encoding: 'utf8' })
    if (!content.stdout) return ''
    const lines = content.stdout.split('\n')
    const diffLines = [
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      `--- /dev/null`,
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(l => `+${l}`),
    ]
    return diffLines.join('\n')
  }
  catch { return '' }
}
