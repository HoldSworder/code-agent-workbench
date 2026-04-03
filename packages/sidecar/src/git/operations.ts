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

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', worktreePath, '--force'])
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(cwd, ['branch', '--show-current'])
}
