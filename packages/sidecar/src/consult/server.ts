import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import type Database from 'better-sqlite3'
import { ConsultChatHandler } from './chat-handler'
import { handleApiRequest, type RouteContext } from './routes'
import type { ConsultConfig, ConsultServerStatus } from './types'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export class ConsultServer {
  private server: Server | null = null
  private chatHandler: ConsultChatHandler
  private db: Database.Database
  private staticDir: string
  private port = 3100

  constructor(opts: { db: Database.Database, config: ConsultConfig, staticDir?: string }) {
    this.db = opts.db
    this.chatHandler = new ConsultChatHandler(opts.config)
    if (!opts.staticDir) throw new Error('ConsultServer requires an explicit staticDir path')
    this.staticDir = opts.staticDir
    this.port = opts.config.port
  }

  updateConfig(config: Partial<ConsultConfig>): void {
    this.chatHandler.updateConfig(config)
    if (config.port != null) this.port = config.port
  }

  async start(port?: number): Promise<void> {
    if (this.server) return

    if (port != null) this.port = port

    const ctx: RouteContext = {
      db: this.db,
      chatHandler: this.chatHandler,
      getLocalIp: () => getLocalIp(),
      getPort: () => this.port,
    }

    this.server = createServer(async (req, res) => {
      this.setCors(res)

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      try {
        const handled = await handleApiRequest(req, res, ctx)
        if (!handled) await this.serveStatic(req, res)
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      }
    })

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => {
        process.stderr.write(`consult: server started on http://0.0.0.0:${this.port}\n`)
        resolve()
      })
      this.server!.on('error', (err) => {
        this.server = null
        reject(err)
      })
    })
  }

  async stop(): Promise<void> {
    this.chatHandler.destroyAll()
    if (!this.server) return

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null
        process.stderr.write('consult: server stopped\n')
        resolve()
      })
    })
  }

  getStatus(): ConsultServerStatus {
    return {
      running: this.server !== null,
      port: this.server ? this.port : null,
      localIp: this.server ? getLocalIp() : null,
    }
  }

  listSessions() {
    return this.chatHandler.listSessions()
  }

  getSessionMessages(sessionId: string) {
    return this.chatHandler.getSessionMessages(sessionId)
  }

  private setCors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id')
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath === '/') urlPath = '/index.html'

    const filePath = join(this.staticDir, urlPath)

    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) throw new Error('Not a file')

      const ext = extname(filePath)
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
      const content = await readFile(filePath)

      res.writeHead(200, { 'Content-Type': mime })
      res.end(content)
    } catch {
      // SPA fallback: serve index.html for unmatched routes
      try {
        const indexPath = join(this.staticDir, 'index.html')
        const content = await readFile(indexPath)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(content)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      }
    }
  }
}

function getLocalIp(): string | null {
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal)
        return iface.address
    }
  }
  return null
}
