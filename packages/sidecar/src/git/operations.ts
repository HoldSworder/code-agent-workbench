import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const opts: Record<string, any> = { cwd, encoding: 'utf8' }
  if (timeoutMs) opts.timeout = timeoutMs
  const { stdout } = await exec('git', args, opts)
  return stdout.trim()
}

const FETCH_TIMEOUT_MS = 15_000

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  let useRemote = false
  try {
    await git(repoPath, ['fetch', '--depth=1', 'origin', baseBranch], FETCH_TIMEOUT_MS)
    useRemote = true
  }
  catch {
    // remote fetch failed or timed out — fall back to local branch
  }
  const base = useRemote ? `origin/${baseBranch}` : baseBranch
  await git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, base])
}

/**
 * Create a feature branch in the repo following the naming convention:
 * feature/<english-slug>
 *
 * Steps: detect base branch → checkout base → pull (with timeout) → checkout -b feature/xxx
 * Returns the created branch name.
 */
export async function createFeatureBranch(
  repoPath: string,
  slug: string,
  baseBranch: string,
): Promise<string> {
  const branchName = `feature/${slug}`

  const current = await getCurrentBranch(repoPath)
  if (current === branchName) return branchName

  const localBranches = await git(repoPath, ['branch', '--list', branchName])
  if (localBranches) {
    await git(repoPath, ['checkout', branchName])
    return branchName
  }

  await git(repoPath, ['checkout', baseBranch])

  try {
    await git(repoPath, ['pull', 'origin', baseBranch], FETCH_TIMEOUT_MS)
  }
  catch {
    // network unavailable — continue with local state
  }

  await git(repoPath, ['checkout', '-b', branchName])
  return branchName
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
 * Get all changed files relative to baseSha.
 * When baseSha is provided, compares baseSha to the working tree (committed + staged + unstaged).
 * When baseSha is null, only shows uncommitted + untracked working tree changes.
 */
export async function getChangedFiles(cwd: string, baseSha: string | null): Promise<ChangedFile[]> {
  const fileMap = new Map<string, ChangedFile>()

  if (baseSha) {
    const numstat = await git(cwd, ['diff', '--numstat', '--diff-filter=ADMR', baseSha]).catch(() => '')
    const nameStatus = await git(cwd, ['diff', '--name-status', '--diff-filter=ADMR', baseSha]).catch(() => '')

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
  else {
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
 * Get unified diff for a single file.
 * When baseSha is provided, compares baseSha to the working tree (covers committed + staged + unstaged).
 * Falls back to unstaged diff or synthesises a new-file diff for untracked files.
 */
export async function getFileDiff(cwd: string, baseSha: string | null, filePath: string): Promise<string> {
  if (baseSha) {
    const diff = await git(cwd, ['diff', '--unified=5', baseSha, '--', filePath]).catch(() => '')
    if (diff) return diff
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
