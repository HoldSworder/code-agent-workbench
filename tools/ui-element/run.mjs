#!/usr/bin/env node
// Emit interactive UI elements (forms, selects, buttons) that the desktop
// frontend renders inside the conversation window.  Users interact with them
// and the response is written back to the same JSON file so the agent can
// read it on the next turn.
// Part of the code-agent WorkflowTool system.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)

function parseArgs(raw) {
  const opts = {}
  const positional = []
  let i = 0
  while (i < raw.length) {
    if (raw[i].startsWith('--') && i + 1 < raw.length) {
      const key = raw[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      opts[key] = raw[i + 1]
      i += 2
    }
    else {
      positional.push(raw[i])
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

const elementsDir = join(dir, '.code-agent', 'ui-elements')

function ensureDir() {
  if (!existsSync(elementsDir)) mkdirSync(elementsDir, { recursive: true })
}

function elementPath(id) {
  return join(elementsDir, `${id}.json`)
}

const VALID_TYPES = ['select', 'form', 'actions']

switch (cmd) {
  case 'emit': {
    const type = opts.type
    if (!type || !VALID_TYPES.includes(type)) {
      console.error(JSON.stringify({ error: `--type is required. Must be one of: ${VALID_TYPES.join(', ')}` }))
      process.exit(1)
    }
    if (!opts.schema) {
      console.error(JSON.stringify({ error: '--schema <JSON> is required' }))
      process.exit(1)
    }

    let schema
    try {
      schema = JSON.parse(opts.schema)
    }
    catch (e) {
      console.error(JSON.stringify({ error: `Invalid --schema JSON: ${e.message}` }))
      process.exit(1)
    }

    const id = opts.id ?? randomUUID().slice(0, 8)
    const element = {
      id,
      type,
      ...schema,
      phaseId: opts.phase ?? null,
      createdAt: Math.floor(Date.now() / 1000),
      response: null,
      respondedAt: null,
    }

    ensureDir()
    writeFileSync(elementPath(id), JSON.stringify(element, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, id }))
    break
  }

  case 'read-response': {
    const id = opts.id
    if (!id) {
      console.error(JSON.stringify({ error: '--id is required for read-response' }))
      process.exit(1)
    }
    const fp = elementPath(id)
    if (!existsSync(fp)) {
      console.log(JSON.stringify({ error: 'not_found', id }))
      break
    }
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8'))
      if (data.response != null) {
        console.log(JSON.stringify({ id, status: 'responded', response: data.response }))
      }
      else {
        console.log(JSON.stringify({ id, status: 'pending', response: null }))
      }
    }
    catch (e) {
      console.error(JSON.stringify({ error: `Failed to read element: ${e.message}` }))
      process.exit(1)
    }
    break
  }

  case 'list': {
    if (!existsSync(elementsDir)) {
      console.log(JSON.stringify([]))
      break
    }
    const files = readdirSync(elementsDir).filter(f => f.endsWith('.json'))
    const result = []
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(elementsDir, f), 'utf-8'))
        result.push({
          id: data.id,
          type: data.type,
          title: data.title ?? null,
          hasResponse: data.response != null,
        })
      }
      catch { /* skip malformed files */ }
    }
    console.log(JSON.stringify(result))
    break
  }

  case 'clear': {
    if (opts.all === 'true' || opts.all === '') {
      if (existsSync(elementsDir)) {
        for (const f of readdirSync(elementsDir).filter(f => f.endsWith('.json'))) {
          unlinkSync(join(elementsDir, f))
        }
      }
      console.log(JSON.stringify({ ok: true, cleared: 'all' }))
    }
    else if (opts.id) {
      const fp = elementPath(opts.id)
      if (existsSync(fp)) unlinkSync(fp)
      console.log(JSON.stringify({ ok: true, cleared: opts.id }))
    }
    else {
      console.error(JSON.stringify({ error: '--id <element-id> or --all is required for clear' }))
      process.exit(1)
    }
    break
  }

  default:
    console.log(`Usage: node run.mjs --dir <worktree_path> [options] <command>

Commands:
  emit            Write a UI element schema file for the frontend to render
  read-response   Read user's response for a specific element
  list            List all UI elements and their status
  clear           Remove element(s)

Options (for emit):
  --type <type>     select | form | actions (required)
  --schema <JSON>   Full schema JSON string (required)
  --id <id>         Element identifier (auto-generated if omitted)
  --phase <id>      Associate with a phase

Options (for read-response):
  --id <id>         Element identifier (required)

Options (for clear):
  --id <id>         Remove a single element
  --all             Remove all elements`)
    break
}
