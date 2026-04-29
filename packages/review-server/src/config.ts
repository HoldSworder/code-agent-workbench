import { resolve } from 'node:path'

export interface ServerConfig {
  port: number
  dbPath: string
}

function parseArg(name: string): string | undefined {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined
}

export function loadConfig(): ServerConfig {
  const projectRoot = resolve(process.cwd())
  const port = Number(process.env.REVIEW_SERVER_PORT ?? parseArg('port') ?? 4100)
  const dbPath = process.env.REVIEW_DB_PATH
    ?? parseArg('db-path')
    ?? resolve(projectRoot, 'data', 'review-server.db')
  return { port, dbPath }
}
