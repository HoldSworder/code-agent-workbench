type RpcHandler = (params: any) => Promise<any>

export class RpcServer {
  private handlers = new Map<string, RpcHandler>()

  register(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler)
  }

  async handle(line: string): Promise<string> {
    let id: number | string | null = null
    try {
      const request = JSON.parse(line)
      id = request.id
      const handler = this.handlers.get(request.method)
      if (!handler) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
      }
      const result = await handler(request.params ?? {})
      return JSON.stringify({ jsonrpc: '2.0', id, result })
    }
    catch (err: any) {
      if (id === null) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })
      }
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message },
      })
    }
  }
}
