import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScriptProvider } from '../../src/providers/script.provider'

const baseContext = {
  phaseId: 'design',
  repoPath: tmpdir(),
  openspecPath: '/tmp/openspec',
  branchName: 'feature/test',
  skillContent: 'skill',
}

describe('ScriptProvider', () => {
  it('returns success when script exits 0 and captures stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidecar-script-'))
    const scriptPath = join(dir, 'ok.sh')
    writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf8')
    chmodSync(scriptPath, 0o755)

    const provider = new ScriptProvider(scriptPath)
    const result = await provider.run(baseContext)

    expect(result.status).toBe('success')
    expect(result.output).toBe('hello')
    expect(result.error).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
  })

  it('returns failed when script exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidecar-script-'))
    const scriptPath = join(dir, 'fail.sh')
    writeFileSync(
      scriptPath,
      '#!/bin/sh\necho err >&2\nexit 1\n',
      'utf8',
    )
    chmodSync(scriptPath, 0o755)

    const provider = new ScriptProvider(scriptPath)
    const result = await provider.run(baseContext)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('err')

    rmSync(dir, { recursive: true, force: true })
  })
})
