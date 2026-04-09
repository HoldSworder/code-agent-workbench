import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZodError } from 'zod'
import { parseTeamConfig } from '../../src/orchestrator/team-parser'

describe('parseTeamConfig', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'team-parser-'))
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('parses valid YAML with prompt_template', () => {
    const yaml = `
name: Alpha Team
description: Test team
polling:
  interval_seconds: 45
  board_filter:
    status: open
roles:
  leader:
    description: Leads
    provider: claude-code
    model: sonnet
    prompt_template: "You are the leader."
  worker:
    description: Implements
    provider: codex
    prompt_template: "Build stuff."
`
    const config = parseTeamConfig(yaml, baseDir)
    expect(config.name).toBe('Alpha Team')
    expect(config.description).toBe('Test team')
    expect(config.polling.interval_seconds).toBe(45)
    expect(config.polling.board_filter).toEqual({ status: 'open' })
    expect(config.roles.leader.prompt_template).toBe('You are the leader.')
    expect(config.roles.leader.model).toBe('sonnet')
    expect(config.roles.worker.provider).toBe('codex')
    expect(config.roles.worker.prompt_template).toBe('Build stuff.')
    expect(config.roles.worker).not.toHaveProperty('prompt_file')
  })

  it('resolves prompt_file content into prompt_template', () => {
    const promptPath = join(baseDir, 'leader.md')
    writeFileSync(promptPath, 'File-based prompt\nline 2', 'utf-8')

    const yaml = `
name: Beta
polling:
  interval_seconds: 10
roles:
  leader:
    description: L
    provider: cursor-cli
    prompt_file: leader.md
`
    const config = parseTeamConfig(yaml, baseDir)
    expect(config.roles.leader.prompt_template).toBe('File-based prompt\nline 2')
  })

  it('throws ZodError when leader role is missing', () => {
    const yaml = `
name: Team
polling:
  interval_seconds: 1
roles:
  worker:
    description: W
    provider: codex
    prompt_template: "x"
`
    expect(() => parseTeamConfig(yaml, baseDir)).toThrow(ZodError)
  })

  it('throws ZodError for invalid provider', () => {
    const yaml = `
name: Team
polling:
  interval_seconds: 1
roles:
  leader:
    description: L
    provider: unknown-provider
    prompt_template: "x"
`
    expect(() => parseTeamConfig(yaml, baseDir)).toThrow(ZodError)
  })

  it('throws when role has neither prompt_template nor prompt_file', () => {
    const yaml = `
name: Team
polling:
  interval_seconds: 1
roles:
  leader:
    description: L
    provider: claude-code
`
    expect(() => parseTeamConfig(yaml, baseDir)).toThrow(
      'role must have either prompt_template or prompt_file',
    )
  })

  it('throws when prompt_file does not exist', () => {
    const yaml = `
name: Team
polling:
  interval_seconds: 1
roles:
  leader:
    description: L
    provider: claude-code
    prompt_file: missing.md
`
    expect(() => parseTeamConfig(yaml, baseDir)).toThrow(/prompt_file not found/)
  })

  it('throws ZodError for empty name', () => {
    const yaml = `
name: ""
polling:
  interval_seconds: 1
roles:
  leader:
    description: L
    provider: codex
    prompt_template: "x"
`
    expect(() => parseTeamConfig(yaml, baseDir)).toThrow(ZodError)
  })

  it('throws ZodError for non-positive interval_seconds', () => {
    const yaml = `
name: Team
polling:
  interval_seconds: -3
roles:
  leader:
    description: L
    provider: codex
    prompt_template: "x"
`
    expect(() => parseTeamConfig(yaml, baseDir)).toThrow(ZodError)
  })
})
