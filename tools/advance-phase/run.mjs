#!/usr/bin/env node
// 通知 engine：当前 phase 已完成，请求推进到下一阶段。
// Engine 在 phase 结果回调里读取 .code-agent/advance-request.json，
// 校验 gate 后决定状态机迁移（进入下一 phase / 挂起等用户确认 / 把错误回传）。

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
  return { opts, cmd: positional[0] ?? 'request' }
}

const { opts, cmd } = parseArgs(args)
const dir = opts.dir

if (!dir) {
  console.error(JSON.stringify({ error: 'Missing required arg: --dir <worktree_path>' }))
  process.exit(1)
}

const signalDir = join(dir, '.code-agent')
const requestFile = join(signalDir, 'advance-request.json')

switch (cmd) {
  case 'request': {
    const phase = opts.phase
    if (!phase) {
      console.error(JSON.stringify({ error: '--phase (current phase id) is required' }))
      process.exit(1)
    }
    const mode = opts.mode ?? 'next'
    if (!['next', 'target', 'pending_input', 'terminal'].includes(mode)) {
      console.error(JSON.stringify({ error: `Invalid --mode: ${mode}. Must be next|target|pending_input|terminal` }))
      process.exit(1)
    }
    if (mode === 'target' && !opts.target) {
      console.error(JSON.stringify({ error: '--target <phase_id> is required when --mode target' }))
      process.exit(1)
    }
    const payload = {
      fromPhaseId: phase,
      mode,
      target: opts.target,
      note: opts.note,
      requestedAt: Math.floor(Date.now() / 1000),
    }
    if (!existsSync(signalDir)) mkdirSync(signalDir, { recursive: true })
    writeFileSync(requestFile, JSON.stringify(payload, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, payload }))
    break
  }

  case 'read': {
    if (existsSync(requestFile)) {
      console.log(readFileSync(requestFile, 'utf-8'))
    }
    else {
      console.log(JSON.stringify({ status: 'no_request' }))
    }
    break
  }

  case 'clear': {
    if (existsSync(requestFile)) unlinkSync(requestFile)
    console.log(JSON.stringify({ ok: true }))
    break
  }

  default:
    console.log(`Usage: node run.mjs --dir <worktree_path> --phase <current_phase_id> [options] <command>

Commands:
  request   写入 advance-request.json，向 engine 请求推进
  read      读取当前 advance-request.json
  clear     删除 advance-request.json

Options (for request):
  --phase <id>          当前 phase id（必填，由 prompt 模板预填）
  --mode <mode>         next | target | pending_input | terminal
                        - next: 推进到下一个非 optional phase
                        - target: 推进到 --target 指定的 phase（可用于激活 optional / 跳过）
                        - pending_input: 当前 phase 未完成，主动挂起等待用户输入
                        - terminal: 整任务终结（仅 release/archive-deploy 用）
  --target <phase_id>   target 模式下的目标 phase id
  --note <text>         可选说明，会写入消息流给用户看`)
    break
}
