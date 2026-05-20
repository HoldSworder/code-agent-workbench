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

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(cwd, ['branch', '--show-current'])
}

export async function getHead(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD'])
}

/**
 * Stash any uncommitted changes (tracked + untracked) before performing
 * a destructive git operation. Returns true if a stash was created.
 */
export async function stashIfDirty(cwd: string, message: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain'])
  if (!status.trim()) return false
  await git(cwd, ['stash', 'push', '--include-untracked', '-m', message])
  return true
}

export async function resetHard(cwd: string, commitSha: string): Promise<void> {
  await git(cwd, ['reset', '--hard', commitSha])
}

export async function resetHardClean(cwd: string, commitSha: string): Promise<void> {
  await git(cwd, ['reset', '--hard', commitSha])
  await git(cwd, ['clean', '-fd'])
}

/**
 * Detect the canonical default branch of a repository, trying in order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` (set by `clone` / `remote set-head`)
 *   2. `git rev-parse --verify origin/master`
 *   3. `git rev-parse --verify origin/main`
 *   4. current local branch via `git rev-parse --abbrev-ref HEAD`
 * Throws when none of the above succeed.
 */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/)
    if (m && m[1]) return m[1]
  }
  catch {}
  for (const cand of ['master', 'main']) {
    try {
      await git(repoPath, ['rev-parse', '--verify', `origin/${cand}`])
      return cand
    }
    catch {}
  }
  try {
    const local = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (local && local !== 'HEAD') return local
  }
  catch {}
  throw new Error(`Cannot detect default branch in ${repoPath}`)
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

// ─────────────────────────────────────────────────────────────
// Worktree operations
// ─────────────────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string
  branch: string | null
  head: string
}

/**
 * Create a new git worktree at `worktreePath`, checking out `branchName`
 * created from `baseSha`. If the branch already exists, it will be reused
 * (without -b). Throws if `worktreePath` already exists.
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseSha: string,
): Promise<void> {
  const branches = await git(repoPath, ['branch', '--list', branchName]).catch(() => '')
  if (branches.trim()) {
    await git(repoPath, ['worktree', 'add', worktreePath, branchName])
  }
  else {
    await git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, baseSha])
  }
}

/**
 * Rename the branch currently checked out at `worktreePath` to `newName`.
 *
 * 内部使用 `git branch -m <newName>`（隐式作用于 HEAD），与
 * `worker-runner` / archive-deploy 等使用同一 worktree 的代码安全共存。
 */
export async function renameCurrentBranch(
  worktreePath: string,
  newName: string,
): Promise<void> {
  await git(worktreePath, ['branch', '-m', newName])
}

/**
 * 校验某分支是否已合入 `targetBranch`。
 * 实现：`git -C <repo> branch --merged <targetBranch>` 输出列表中包含该分支即视为已合并。
 * 同时容忍 `origin/<targetBranch>` 已合并、本地 target 落后的场景。
 */
export async function isBranchMergedInto(
  repoPath: string,
  branchName: string,
  targetBranch: string,
): Promise<boolean> {
  const candidates = [targetBranch, `origin/${targetBranch}`]
  for (const ref of candidates) {
    let out = ''
    try { out = await git(repoPath, ['branch', '--list', '--merged', ref, branchName]) }
    catch { continue }
    if (out.trim()) return true
  }
  return false
}

/**
 * Delete a local branch. `force=true` maps to `-D` for unmerged branches; otherwise `-d`.
 */
export async function deleteBranch(
  repoPath: string,
  branchName: string,
  force = false,
): Promise<void> {
  await git(repoPath, ['branch', force ? '-D' : '-d', branchName])
}

/**
 * Remove a git worktree. By default uses --force to drop dirty trees.
 * Safe to call when the path no longer exists; emits no error in that case.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = true,
): Promise<void> {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)
  try {
    await git(repoPath, args)
  }
  catch {
    // Best-effort prune to clean stale metadata even when path is gone.
    try { await git(repoPath, ['worktree', 'prune']) } catch {}
  }
}

/**
 * List all git worktrees registered for `repoPath` (porcelain v2 parse).
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain']).catch(() => '')
  if (!out) return []
  const entries: WorktreeEntry[] = []
  let cur: Partial<WorktreeEntry> = {}
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '' })
      cur = { path: line.slice('worktree '.length).trim() }
    }
    else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim()
    }
    else if (line.startsWith('branch ')) {
      // refs/heads/<name>
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
    else if (line === 'detached') {
      cur.branch = null
    }
  }
  if (cur.path) entries.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '' })
  return entries
}

/**
 * Merge `sourceBranch` into the current branch of `worktreePath` with a
 * non-fast-forward merge commit. Returns the resulting merge commit SHA.
 *
 * On conflict, aborts the merge and throws an Error with message including
 * "merge conflict" so callers can route to a recovery path.
 */
export async function mergeNoFf(
  worktreePath: string,
  sourceBranch: string,
  message: string,
): Promise<string> {
  try {
    await git(worktreePath, ['merge', '--no-ff', '--no-edit', '-m', message, sourceBranch])
  }
  catch (err) {
    try { await git(worktreePath, ['merge', '--abort']) } catch {}
    const e = err instanceof Error ? err.message : String(err)
    throw new Error(`merge conflict while merging ${sourceBranch}: ${e}`)
  }
  return git(worktreePath, ['rev-parse', 'HEAD'])
}

/**
 * Cherry-pick `commitSha` onto the current branch of `worktreePath`. For
 * merge commits, uses `-m 1` (mainline parent). Returns the new commit SHA.
 *
 * Aborts and throws on conflict.
 */
export async function cherryPick(
  worktreePath: string,
  commitSha: string,
  mainlineParent = 1,
): Promise<string> {
  try {
    await git(worktreePath, ['cherry-pick', '-m', String(mainlineParent), commitSha])
  }
  catch (err) {
    try { await git(worktreePath, ['cherry-pick', '--abort']) } catch {}
    const e = err instanceof Error ? err.message : String(err)
    throw new Error(`cherry-pick conflict on ${commitSha}: ${e}`)
  }
  return git(worktreePath, ['rev-parse', 'HEAD'])
}

/**
 * Append a pattern to `.git/info/exclude` (per-repo, not committed) if not
 * already present. Used to hide `.worktrees/` from `git status` in the main
 * repo without touching user's `.gitignore`.
 */
export async function ensureLocalExclude(repoPath: string, pattern: string): Promise<void> {
  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  try {
    const gitDir = (await git(repoPath, ['rev-parse', '--git-common-dir'])).trim()
    const absGitDir = gitDir.startsWith('/') ? gitDir : join(repoPath, gitDir)
    const infoDir = join(absGitDir, 'info')
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true })
    const excludePath = join(infoDir, 'exclude')
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    const lines = current.split('\n').map(l => l.trim())
    if (!lines.includes(pattern)) {
      const next = (current.endsWith('\n') || current === '' ? current : `${current}\n`) + `${pattern}\n`
      writeFileSync(excludePath, next, 'utf8')
    }
  }
  catch { /* best effort */ }
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
