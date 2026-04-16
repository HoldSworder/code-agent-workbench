#!/usr/bin/env node
// Report phase step-level progress by writing a JSON signal file.
// Part of the code-agent WorkflowTool system.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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
  return { opts, cmd: positional[0] ?? 'help' }
}

const { opts, cmd } = parseArgs(args)
const dir = opts.dir

if (!dir) {
  console.error(JSON.stringify({ error: 'Missing required arg: --dir <worktree_path>' }))
  process.exit(1)
}

const signalDir = join(dir, '.code-agent')
const signalFile = join(signalDir, 'phase-signal.json')

switch (cmd) {
  case 'update': {
    const phase = opts.phase
    if (!phase) {
      console.error(JSON.stringify({ error: '--phase is required for update' }))
      process.exit(1)
    }
    const status = opts.status ?? 'in_progress'
    if (!['in_progress', 'ready', 'blocked'].includes(status)) {
      console.error(JSON.stringify({ error: `Invalid --status: ${status}. Must be in_progress|ready|blocked` }))
      process.exit(1)
    }
    const signal = { phaseId: phase, status }
    if (opts.step) signal.step = opts.step
    if (opts.stepName) signal.stepName = opts.stepName
    if (opts.reason) signal.reason = opts.reason
    signal.updatedAt = Math.floor(Date.now() / 1000)

    if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true })
    writeFileSync(signalFile, JSON.stringify(signal, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true }))
    break
  }

  case 'read': {
    if (existsSync(signalFile)) {
      console.log(readFileSync(signalFile, 'utf-8'))
    }
    else {
      console.log(JSON.stringify({ status: 'no_signal' }))
    }
    break
  }

  case 'clear': {
    if (existsSync(signalFile)) unlinkSync(signalFile)
    console.log(JSON.stringify({ ok: true }))
    break
  }

  default:
    console.log(`Usage: node phase-signal.mjs --dir <worktree_path> [options] <command>

Commands:
  update   Write/update the phase signal file
  read     Read the current signal (or {"status":"no_signal"} if none)
  clear    Remove the signal file

Options (for update):
  --phase <id>                Phase identifier (required)
  --status <status>           in_progress | ready | blocked (default: in_progress)
  --step <progress>           Step progress, e.g. "2/7"
  --step-name <name>          Human-readable step name
  --reason <text>             Why the phase is in this status`)
    break
}
