#!/usr/bin/env node
// Evaluate gate conditions defined in workflow.yaml.
// Part of the code-agent WorkflowTool system.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)

function parseArgs(argv) {
  const opts = {}
  const positional = []
  let i = 0
  while (i < argv.length) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      opts[key] = argv[i + 1]
      i += 2
    }
    else {
      positional.push(argv[i])
      i++
    }
  }
  return { opts, cmd: positional[0] ?? 'help', cmdArg: positional[1] }
}

const { opts, cmd, cmdArg } = parseArgs(args)

const dir = opts.dir
const openspec = opts.openspec ?? ''

if (!dir) {
  console.error(JSON.stringify({ error: 'Missing required arg: --dir <worktree_path>' }))
  process.exit(1)
}

if (!opts.gates) {
  console.error(JSON.stringify({ error: 'Missing required arg: --gates <base64_json>' }))
  process.exit(1)
}

let gateDefs
try {
  gateDefs = JSON.parse(Buffer.from(opts.gates, 'base64').toString('utf-8'))
}
catch (err) {
  console.error(JSON.stringify({ error: `Failed to decode --gates: ${err.message}` }))
  process.exit(1)
}

function resolveTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
}

function evaluateCheck(check, worktreePath, vars) {
  try {
    if (check.type === 'command_succeeds') {
      if (!check.command) return { type: check.type, command: check.command, passed: false }
      const resolved = resolveTemplate(check.command, vars)
      try {
        execSync(resolved, { cwd: worktreePath, stdio: 'pipe', timeout: 10_000 })
        return { type: check.type, command: resolved, passed: true }
      }
      catch {
        return { type: check.type, command: resolved, passed: false }
      }
    }

    if (!check.path)
      return { type: check.type, path: null, passed: false }

    const absPath = join(worktreePath, resolveTemplate(check.path, vars))

    switch (check.type) {
      case 'exists':
        return { type: check.type, path: absPath, passed: existsSync(absPath) }

      case 'not_exists':
        return { type: check.type, path: absPath, passed: !existsSync(absPath) }

      case 'file_contains': {
        if (!check.pattern || !existsSync(absPath))
          return { type: check.type, path: absPath, pattern: check.pattern, passed: false }
        const content = readFileSync(absPath, 'utf-8')
        return { type: check.type, path: absPath, pattern: check.pattern, passed: content.includes(check.pattern) }
      }

      case 'file_not_contains': {
        if (!check.pattern || !existsSync(absPath))
          return { type: check.type, path: absPath, pattern: check.pattern, passed: false }
        const content = readFileSync(absPath, 'utf-8')
        return { type: check.type, path: absPath, pattern: check.pattern, passed: !content.includes(check.pattern) }
      }

      case 'file_section_matches': {
        if (!check.pattern || !check.after || !existsSync(absPath))
          return { type: check.type, path: absPath, pattern: check.pattern, passed: false }
        const content = readFileSync(absPath, 'utf-8')
        const section = content.split(check.after)[1] ?? ''
        return { type: check.type, path: absPath, pattern: check.pattern, passed: new RegExp(check.pattern).test(section) }
      }

      case 'file_section_not_matches': {
        if (!check.pattern || !check.after || !existsSync(absPath))
          return { type: check.type, path: absPath, pattern: check.pattern, passed: false }
        const content = readFileSync(absPath, 'utf-8')
        const section = content.split(check.after)[1] ?? ''
        return { type: check.type, path: absPath, pattern: check.pattern, passed: !new RegExp(check.pattern).test(section) }
      }

      default:
        return { type: check.type, path: absPath, passed: false }
    }
  }
  catch (err) {
    return { type: check.type, passed: false, error: err.message }
  }
}

function evaluateGate(gateName) {
  const def = gateDefs[gateName]
  if (!def) return { gate: gateName, passed: false, error: `Gate "${gateName}" not found` }

  const vars = {
    openspec_path: openspec,
    repo_path: dir,
  }

  const checks = def.checks.map(c => evaluateCheck(c, dir, vars))
  const passed = checks.every(c => c.passed)

  return { gate: gateName, passed, checks }
}

switch (cmd) {
  case 'check': {
    if (!cmdArg) {
      console.error(JSON.stringify({ error: 'Usage: check <gate_name>' }))
      process.exit(1)
    }
    console.log(JSON.stringify(evaluateGate(cmdArg), null, 2))
    break
  }

  case 'list': {
    const gates = Object.entries(gateDefs).map(([name, def]) => {
      const result = evaluateGate(name)
      return { name, description: def.description, passed: result.passed }
    })
    console.log(JSON.stringify({ gates }, null, 2))
    break
  }

  default:
    console.log(`Usage: node run.mjs --dir <worktree_path> --openspec <openspec_path> --gates <base64_json> <command> [args]

Commands:
  check <gate_name>   Evaluate a specific gate and return detailed results
  list                Evaluate all gates and return summary`)
    break
}
