import { describe, it, expect } from 'vitest'
import { parseWorkflow } from '../../src/workflow/parser'

const VALID_YAML = `
name: test-workflow
description: Test
phases:
  - id: design
    name: 设计
    requires_confirm: true
    provider: api
    skill: skills/design.md
    tools:
      - read-file
  - id: dev
    name: 开发
    requires_confirm: false
    provider: external-cli
    skill: skills/dev.md
    mcp_config: mcp-configs/dev.json
events:
  - id: backend-spec
    name: 后端 Spec
    after_phase: dev
    skill: skills/integration.md
    provider: api
`

describe('parseWorkflow', () => {
  it('parses valid YAML into WorkflowConfig', () => {
    const config = parseWorkflow(VALID_YAML)
    expect(config.name).toBe('test-workflow')
    expect(config.phases).toHaveLength(2)
    expect(config.phases[0].id).toBe('design')
    expect(config.phases[0].requires_confirm).toBe(true)
    expect(config.phases[0].tools).toEqual(['read-file'])
    expect(config.phases[1].mcp_config).toBe('mcp-configs/dev.json')
    expect(config.events).toHaveLength(1)
    expect(config.events![0].after_phase).toBe('dev')
  })

  it('throws on missing required fields', () => {
    expect(() => parseWorkflow('name: x')).toThrow()
  })

  it('throws on invalid provider type', () => {
    const yaml = `
name: x
description: x
phases:
  - id: a
    name: A
    requires_confirm: false
    provider: magic
    skill: x.md
`
    expect(() => parseWorkflow(yaml)).toThrow()
  })
})
