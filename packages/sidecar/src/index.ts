import { createInterface } from 'node:readline'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getDb } from './db/connection'
import { RpcServer } from './rpc/server'
import { registerMethods } from './rpc/methods'
import { WorkflowEngine } from './workflow/engine'
import { ScriptProvider } from './providers/script.provider'
import { ExternalCliProvider } from './providers/cli.provider'
import { ApiProvider } from './providers/api.provider'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const dbPath = process.env.DB_PATH ?? 'code-agent.db'
const workflowPath = process.env.WORKFLOW_PATH ?? resolve(process.cwd(), 'workflow.yaml')

const db = getDb(dbPath)

let workflowYaml: string
try {
  workflowYaml = readFileSync(workflowPath, 'utf-8')
}
catch {
  workflowYaml = readFileSync(resolve(__dirname, '../../../workflow.yaml'), 'utf-8')
}

const engine = new WorkflowEngine({
  db,
  workflowYaml,
  resolveProvider: (providerType: string) => {
    switch (providerType) {
      case 'script':
        return new ScriptProvider('echo "placeholder"')
      case 'external-cli':
        return new ExternalCliProvider({ type: 'claude-code' })
      case 'api':
        return new ApiProvider({
          type: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY ?? '',
          model: process.env.MODEL ?? 'claude-sonnet-4-20250514',
        })
      default:
        throw new Error(`Unknown provider: ${providerType}`)
    }
  },
  resolveSkillContent: (skillPath: string) => {
    try {
      return readFileSync(resolve(skillPath), 'utf-8')
    }
    catch {
      return ''
    }
  },
})

const rpcServer = new RpcServer()
registerMethods(rpcServer, db, engine)

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const response = await rpcServer.handle(line)
  process.stdout.write(`${response}\n`)
})

process.stderr.write('sidecar: ready\n')
