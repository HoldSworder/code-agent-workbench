import { describe, it, expect } from 'vitest'
import { parseWorkflow } from '../../src/workflow/parser'

const VALID_YAML = `
name: test-workflow
description: Test
stages:
  - id: planning
    name: 规划
    phases:
      - id: design
        name: 设计
        requires_confirm: true
        provider: api
        skill: skills/design.md
        tools:
          - read-file
  - id: development
    name: 开发
    phases:
      - id: dev
        name: 开发
        requires_confirm: false
        provider: external-cli
        skill: skills/dev.md
        mcp_config: mcp-configs/dev.json
`

describe('parseWorkflow', () => {
  it('parses valid YAML into WorkflowConfig', () => {
    const config = parseWorkflow(VALID_YAML)
    expect(config.name).toBe('test-workflow')
    expect(config.stages).toHaveLength(2)
    expect(config.stages[0].id).toBe('planning')
    expect(config.stages[0].phases).toHaveLength(1)
    const design = config.stages[0].phases[0]
    expect(design.id).toBe('design')
    expect(design.requires_confirm).toBe(true)
    expect(design.tools).toEqual(['read-file'])
    expect(config.stages[1].phases[0].mcp_config).toBe('mcp-configs/dev.json')
  })

  it('throws on missing required fields', () => {
    expect(() => parseWorkflow('name: x')).toThrow()
  })

  it('parses llm_judge gate check with prompt and context_files', () => {
    const yaml = `
name: x
description: x
gate_definitions:
  spec_quality_ok:
    description: spec 质量达标
    checks:
      - type: exists
        path: "{{openspec_path}}/proposal.md"
      - type: llm_judge
        prompt: "proposal 是否覆盖背景/目标/验收？"
        context_files:
          - "{{openspec_path}}/proposal.md"
stages:
  - id: s
    name: S
    phases:
      - id: a
        name: A
        provider: external-cli
        skill: x.md
`
    const config = parseWorkflow(yaml)
    const checks = config.gate_definitions!.spec_quality_ok.checks
    expect(checks).toHaveLength(2)
    expect(checks[1].type).toBe('llm_judge')
    expect(checks[1].prompt).toContain('验收')
    expect(checks[1].context_files).toEqual(['{{openspec_path}}/proposal.md'])
  })

  it('throws on invalid provider type', () => {
    const yaml = `
name: x
description: x
stages:
  - id: s
    name: S
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
