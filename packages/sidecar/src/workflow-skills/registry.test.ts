import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanWorkflowSkills,
  getWorkflowSkill,
  renderWorkflowSkill,
  createWorkflowSkill,
  updateWorkflowSkill,
  deleteWorkflowSkill,
} from './registry'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-skills-'))
})

function writeSkill(id: string, meta: object, content: string) {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(meta))
  writeFileSync(join(dir, 'SKILL.md'), content)
}

describe('scanWorkflowSkills', () => {
  it('returns empty list when dir does not exist', () => {
    expect(scanWorkflowSkills(join(root, 'nope'))).toEqual([])
  })

  it('skips directories without skill.json', () => {
    mkdirSync(join(root, 'broken'))
    expect(scanWorkflowSkills(root)).toEqual([])
  })

  it('returns valid skills sorted by id', () => {
    writeSkill('b-skill', { id: 'b-skill', name: 'B', description: 'b' }, 'B content')
    writeSkill('a-skill', { id: 'a-skill', name: 'A', description: 'a' }, 'A content')
    const skills = scanWorkflowSkills(root)
    expect(skills.map(s => s.meta.id)).toEqual(['a-skill', 'b-skill'])
    expect(skills[0].content).toBe('A content')
  })

  it('forces id to match directory name', () => {
    writeSkill('real-id', { id: 'lying-id', name: 'X', description: '' }, '')
    const skills = scanWorkflowSkills(root)
    expect(skills[0].meta.id).toBe('real-id')
  })
})

describe('getWorkflowSkill', () => {
  it('returns null for missing skill', () => {
    expect(getWorkflowSkill('nope', root)).toBeNull()
  })

  it('returns skill with content', () => {
    writeSkill('foo', { id: 'foo', name: 'Foo', description: 'd' }, 'hello')
    const s = getWorkflowSkill('foo', root)
    expect(s?.meta.name).toBe('Foo')
    expect(s?.content).toBe('hello')
  })
})

describe('renderWorkflowSkill', () => {
  it('interpolates variables', () => {
    writeSkill('t', { id: 't', name: 'T', description: '' }, 'hello {{name}}, version {{ver}}')
    const r = renderWorkflowSkill('t', { name: 'alice', ver: '1.0' }, root)
    expect(r?.content).toBe('hello alice, version 1.0')
    expect(r?.missingVars).toEqual([])
  })

  it('keeps placeholder and reports missing vars', () => {
    writeSkill('t', { id: 't', name: 'T', description: '' }, 'hi {{who}}')
    const r = renderWorkflowSkill('t', {}, root)
    expect(r?.content).toBe('hi {{who}}')
    expect(r?.missingVars).toContain('who')
  })

  it('applies input defaults', () => {
    writeSkill(
      't',
      {
        id: 't',
        name: 'T',
        description: '',
        inputs: [{ key: 'greeting', default: 'hello' }],
      },
      '{{greeting}} world',
    )
    const r = renderWorkflowSkill('t', {}, root)
    expect(r?.content).toBe('hello world')
  })

  it('reports required inputs not supplied', () => {
    writeSkill(
      't',
      {
        id: 't',
        name: 'T',
        description: '',
        inputs: [{ key: 'x', required: true }],
      },
      'no placeholder here',
    )
    const r = renderWorkflowSkill('t', {}, root)
    expect(r?.missingVars).toContain('x')
  })

  it('returns null for missing skill', () => {
    expect(renderWorkflowSkill('nope', {}, root)).toBeNull()
  })
})

describe('create/update/delete', () => {
  it('creates a new skill', () => {
    const s = createWorkflowSkill(
      { id: 'new-one', name: 'New', description: 'desc', content: 'body' },
      root,
    )
    expect(s.meta.name).toBe('New')
    expect(existsSync(join(root, 'new-one', 'skill.json'))).toBe(true)
    expect(existsSync(join(root, 'new-one', 'SKILL.md'))).toBe(true)
  })

  it('rejects invalid ids', () => {
    expect(() =>
      createWorkflowSkill({ id: 'bad id!', name: 'X' }, root),
    ).toThrow(/非法 skill id/)
  })

  it('rejects duplicate ids', () => {
    createWorkflowSkill({ id: 'dup', name: 'X' }, root)
    expect(() =>
      createWorkflowSkill({ id: 'dup', name: 'Y' }, root),
    ).toThrow(/已存在/)
  })

  it('updates existing skill', () => {
    createWorkflowSkill({ id: 'u1', name: 'Old', description: 'a', content: 'x' }, root)
    const updated = updateWorkflowSkill(
      { id: 'u1', name: 'New', content: 'y' },
      root,
    )
    expect(updated.meta.name).toBe('New')
    expect(updated.content).toBe('y')
  })

  it('throws when updating missing skill', () => {
    expect(() => updateWorkflowSkill({ id: 'gone', name: 'X' }, root)).toThrow(/不存在/)
  })

  it('deletes skill directory', () => {
    createWorkflowSkill({ id: 'del', name: 'X' }, root)
    deleteWorkflowSkill('del', root)
    expect(existsSync(join(root, 'del'))).toBe(false)
  })
})
