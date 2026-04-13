import { describe, it, expect } from 'vitest'
import { parseLeaderDecision } from '../../src/orchestrator/leader'

const minimalAssignment = {
  role: 'worker',
  title: 'Do work',
  description: 'Details',
}

function decisionPayload(
  decision: 'single_worker' | 'split' | 'blocked',
  assignments: typeof minimalAssignment[] = [minimalAssignment],
) {
  return JSON.stringify({
    decision,
    reason: 'because',
    assignments,
  })
}

describe('parseLeaderDecision', () => {
  it('extracts JSON from <decision>...</decision> tags', () => {
    const inner = decisionPayload('single_worker')
    const raw = `  Some text\n<decision>\n${inner}\n</decision>\n trailing `
    const parsed = parseLeaderDecision(raw)
    expect(parsed).toEqual(JSON.parse(inner))
  })

  it('extracts JSON from ```json code blocks', () => {
    const inner = decisionPayload('split', [
      { role: 'a', title: 'T1', description: 'D1' },
      { role: 'b', title: 'T2', description: 'D2' },
    ])
    const raw = `Intro:\n\`\`\`json\n${inner}\n\`\`\`\nDone.`
    const parsed = parseLeaderDecision(raw)
    expect(parsed?.decision).toBe('split')
    expect(parsed?.assignments).toHaveLength(2)
  })

  it('extracts JSON from raw text containing a decision object', () => {
    const inner = decisionPayload('blocked', [])
    const raw = `Here you go: ${inner} — end.`
    const parsed = parseLeaderDecision(raw)
    expect(parsed?.decision).toBe('blocked')
    expect(parsed?.assignments).toEqual([])
  })

  it('returns null for completely invalid text', () => {
    expect(parseLeaderDecision('no json here at all')).toBeNull()
    expect(parseLeaderDecision('')).toBeNull()
  })

  it('returns null when JSON omits required fields', () => {
    expect(parseLeaderDecision('{"decision":"single_worker"}')).toBeNull()
    expect(parseLeaderDecision('{"foo":1}')).toBeNull()
  })

  it('accepts decision type single_worker', () => {
    const d = parseLeaderDecision(decisionPayload('single_worker'))
    expect(d?.decision).toBe('single_worker')
  })

  it('accepts decision type split', () => {
    const d = parseLeaderDecision(decisionPayload('split'))
    expect(d?.decision).toBe('split')
  })

  it('accepts decision type blocked', () => {
    const d = parseLeaderDecision(decisionPayload('blocked', []))
    expect(d?.decision).toBe('blocked')
  })

  it('tolerates extra whitespace and surrounding prose', () => {
    const inner = decisionPayload('single_worker')
    const raw = `\n\n  <decision>   \n  ${inner}  \n  </decision>  \n\nMore noise.`
    expect(parseLeaderDecision(raw)).toEqual(JSON.parse(inner))
  })

  it('parses ``` block without json language tag when body starts with {', () => {
    const inner = decisionPayload('single_worker')
    const raw = `x\n\`\`\`\n${inner}\n\`\`\``
    expect(parseLeaderDecision(raw)?.decision).toBe('single_worker')
  })

  it('accepts assignments with optional repo_id', () => {
    const payload = JSON.stringify({
      decision: 'split',
      reason: 'multi-repo',
      assignments: [
        { role: 'worker', repo_id: 'repo-frontend', title: 'Frontend', description: 'UI work' },
        { role: 'worker', repo_id: 'repo-backend', title: 'Backend', description: 'API work' },
      ],
    })
    const raw = `<decision>${payload}</decision>`
    const parsed = parseLeaderDecision(raw)
    expect(parsed?.decision).toBe('split')
    expect(parsed?.assignments).toHaveLength(2)
    expect(parsed?.assignments[0]?.repo_id).toBe('repo-frontend')
    expect(parsed?.assignments[1]?.repo_id).toBe('repo-backend')
  })

  it('accepts assignments without repo_id', () => {
    const payload = JSON.stringify({
      decision: 'single_worker',
      reason: 'single repo',
      assignments: [
        { role: 'worker', title: 'Task', description: 'Do something' },
      ],
    })
    const parsed = parseLeaderDecision(payload)
    expect(parsed?.assignments[0]?.repo_id).toBeUndefined()
  })
})
