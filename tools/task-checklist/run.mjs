#!/usr/bin/env node
// Manage tasks.md checkbox state (list / check / uncheck / progress).
// Part of the code-agent WorkflowTool system.

import { readFileSync, writeFileSync } from 'node:fs'

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
  return { opts, cmd: positional[0] ?? 'help', target: positional[1] }
}

const { opts, cmd, target } = parseArgs(args)
const file = opts.file

if (!file) {
  console.error(JSON.stringify({ error: 'Missing required arg: --file <path>' }))
  process.exit(1)
}

const ID_PATTERN = /^(T\d+|任务\d+)\s*[:：]/

function parseTasks(content) {
  const lines = content.split('\n')
  const tasks = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^(\s*-\s*\[)([ xX])(\]\s*)(.*)$/)
    if (!m) continue
    const checked = m[2].toLowerCase() === 'x'
    const title = m[4].trim()
    const idMatch = title.match(ID_PATTERN)
    const id = idMatch ? idMatch[1] : `L${i + 1}`
    tasks.push({ line: i + 1, id, title, checked })
  }
  return { lines, tasks }
}

function findTask(tasks, idOrLine) {
  if (!idOrLine) return null
  const upper = idOrLine.toUpperCase()
  const byId = tasks.find(t => t.id.toUpperCase() === upper)
  if (byId) return byId
  const lineNum = idOrLine.startsWith('L') || idOrLine.startsWith('l')
    ? Number.parseInt(idOrLine.slice(1), 10)
    : Number.parseInt(idOrLine, 10)
  if (!Number.isNaN(lineNum)) {
    return tasks.find(t => t.line === lineNum) ?? null
  }
  return null
}

function readFile() {
  try {
    return readFileSync(file, 'utf-8')
  }
  catch (e) {
    console.error(JSON.stringify({ error: `Cannot read file: ${file}`, detail: e.message }))
    process.exit(1)
  }
}

function progressSummary(tasks) {
  const total = tasks.length
  const completed = tasks.filter(t => t.checked).length
  const pending = total - completed
  return { total, completed, pending, progress: `${completed}/${total}`, allDone: pending === 0 }
}

switch (cmd) {
  case 'list': {
    const content = readFile()
    const { tasks } = parseTasks(content)
    const { total, completed, pending } = progressSummary(tasks)
    console.log(JSON.stringify({ total, completed, pending, tasks }))
    break
  }

  case 'check':
  case 'uncheck': {
    if (!target) {
      console.error(JSON.stringify({ error: `Missing target for ${cmd}. Usage: ${cmd} <id_or_line>` }))
      process.exit(1)
    }
    const content = readFile()
    const { lines, tasks } = parseTasks(content)
    const task = findTask(tasks, target)
    if (!task) {
      console.error(JSON.stringify({ error: `Task not found: ${target}` }))
      process.exit(1)
    }

    const wantChecked = cmd === 'check'
    if (task.checked === wantChecked) {
      console.log(JSON.stringify({
        ok: true,
        [wantChecked ? 'already_checked' : 'already_unchecked']: true,
      }))
      break
    }

    const idx = task.line - 1
    if (wantChecked) {
      lines[idx] = lines[idx].replace('- [ ]', '- [x]')
    }
    else {
      lines[idx] = lines[idx].replace(/- \[[xX]\]/, '- [ ]')
    }
    writeFileSync(file, lines.join('\n'))

    task.checked = wantChecked
    const { total, completed } = progressSummary(
      tasks.map(t => (t.line === task.line ? { ...t, checked: wantChecked } : t)),
    )
    console.log(JSON.stringify({
      ok: true,
      task: { line: task.line, id: task.id, title: task.title, checked: wantChecked },
      progress: `${completed}/${total}`,
    }))
    break
  }

  case 'progress': {
    const content = readFile()
    const { tasks } = parseTasks(content)
    console.log(JSON.stringify(progressSummary(tasks)))
    break
  }

  default:
    console.log(`Usage: node run.mjs --file <tasks_md_path> <command> [target]

Commands:
  list              List all tasks with id/title/status and progress stats
  check <id|line>   Check a task (mark as done)
  uncheck <id|line> Uncheck a task (mark as pending)
  progress          Show progress summary only

Target formats:
  T1, T2, ...       Task id extracted from content
  L3, 3             Line number`)
    break
}
