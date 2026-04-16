#!/usr/bin/env node
// Query openspec change directory status, fetch instruction templates, run validation.
// Part of the code-agent WorkflowTool system.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)

function parseArgs(args) {
  const opts = {}
  const positional = []
  let i = 0
  while (i < args.length) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      opts[key] = args[i + 1]
      i += 2
    }
    else {
      positional.push(args[i])
      i++
    }
  }
  return { opts, cmd: positional[0] ?? 'help', subArg: positional[1] }
}

const { opts, cmd, subArg } = parseArgs(args)
const changeDir = opts.changeDir
const changeId = opts.changeId

if (!changeDir || !changeId) {
  console.error(JSON.stringify({ error: 'Missing required args: --change-dir <path> --change-id <id>' }))
  process.exit(1)
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2))
}

function collectSpecFiles(specsDir) {
  const results = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      }
      else if (entry.name === 'spec.md') {
        results.push(relative(changeDir, full))
      }
    }
  }
  walk(specsDir)
  return results
}

function parseTaskProgress(tasksPath) {
  const content = readFileSync(tasksPath, 'utf-8')
  const checked = (content.match(/- \[x\]/gi) || []).length
  const unchecked = (content.match(/- \[ \]/g) || []).length
  const total = checked + unchecked
  return total > 0 ? `${checked}/${total}` : '0/0'
}

function hasOpenspecCli() {
  try {
    execSync('openspec --version', { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

switch (cmd) {
  case 'status': {
    const exists = existsSync(changeDir) && statSync(changeDir).isDirectory()
    if (!exists) {
      out({ changeId, exists: false, hasProposal: false, hasSpecs: false, specFiles: [], hasTasks: false, hasE2eReport: false, taskProgress: null })
      break
    }

    const hasProposal = existsSync(join(changeDir, 'proposal.md'))
    const specsDir = join(changeDir, 'specs')
    const specsExist = existsSync(specsDir) && statSync(specsDir).isDirectory()
    const specFiles = specsExist ? collectSpecFiles(specsDir) : []
    const hasSpecs = specFiles.length > 0

    const tasksPath = join(changeDir, 'tasks.md')
    const hasTasks = existsSync(tasksPath)
    const taskProgress = hasTasks ? parseTaskProgress(tasksPath) : null

    const hasE2eReport = existsSync(join(changeDir, 'e2e-report.md'))

    out({ changeId, exists: true, hasProposal, hasSpecs, specFiles, hasTasks, hasE2eReport, taskProgress })
    break
  }

  case 'instructions': {
    const type = subArg
    if (!type) {
      console.error(JSON.stringify({ error: 'Missing instruction type. Usage: instructions <proposal|specs|tasks>' }))
      process.exit(1)
    }

    if (!hasOpenspecCli()) {
      out({ type, error: 'openspec not installed', fallback: `请手动在 ${changeDir} 中创建对应的 ${type} 文档` })
      break
    }

    try {
      const result = execSync(`openspec instructions ${type} --change "${changeId}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      out({ type, content: result })
    }
    catch (e) {
      out({ type, error: e.message, stderr: e.stderr?.toString().trim() ?? '' })
    }
    break
  }

  case 'validate': {
    if (!hasOpenspecCli()) {
      const checks = []
      const proposalOk = existsSync(join(changeDir, 'proposal.md'))
      if (!proposalOk) checks.push('proposal.md not found')
      const specsDir = join(changeDir, 'specs')
      const specsOk = existsSync(specsDir) && readdirSync(specsDir).length > 0
      if (!specsOk) checks.push('specs/ directory missing or empty')

      out({
        valid: checks.length === 0,
        errors: checks,
        details: checks.length === 0
          ? 'Basic structure checks passed (openspec CLI not available for full validation)'
          : `Basic structure check failed: ${checks.join('; ')}`,
        fallback: true,
      })
      break
    }

    try {
      const result = execSync(`openspec validate "${changeId}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()

      const hasError = /error|fail|invalid/i.test(result)
      out({
        valid: !hasError,
        errors: hasError ? result.split('\n').filter(l => /error|fail|invalid/i.test(l)) : [],
        details: result,
      })
    }
    catch (e) {
      const stderr = e.stderr?.toString().trim() ?? ''
      const stdout = e.stdout?.toString().trim() ?? ''
      const details = stderr || stdout || e.message
      out({
        valid: false,
        errors: details.split('\n').filter(Boolean),
        details,
      })
    }
    break
  }

  default:
    out({
      usage: 'node run.mjs --change-dir <path> --change-id <id> <command> [args]',
      commands: {
        status: 'Query change directory status',
        'instructions <type>': 'Fetch openspec instruction template (proposal|specs|tasks)',
        validate: 'Run openspec validation',
      },
    })
    break
}
