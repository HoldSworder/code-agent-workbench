import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line)
    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: { echo: request.params, status: 'ok' },
    }
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
  catch (err) {
    const error = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    }
    process.stdout.write(`${JSON.stringify(error)}\n`)
  }
})

process.stderr.write('sidecar: ready\n')
