import net from 'node:net'

/**
 * net 层透明代理补丁（移植自 Cursor agent 自带的 socks5 patch）。
 *
 * 背景：@cursor/sdk 的 run 流式走 @connectrpc/connect-node 的「原生 http2」，
 * 它既不读 HTTP(S)_PROXY 环境变量、也不走 undici 全局 dispatcher。任何在
 * fetch / connect-node 之上做的代理（undici EnvHttpProxyAgent、connect-node
 * 的 CONNECT 隧道补丁）都只能覆盖「部分通道」，导致 run 被后端零输出判 ERROR。
 *
 * 本方案在最底层 monkey-patch `net.Socket.prototype.connect`：
 *  1. 起一个本地 SNI 代理（监听 127.0.0.1，端口由系统分配，避免并发 worker 抢占）。
 *  2. 改写 connect：所有「非本地」目标不再直连，而是连到本地 SNI 代理，并记下原端口。
 *  3. SNI 代理读取 TLS ClientHello 的 SNI 主机名，经 SOCKS5（FlClash 7890 混合端口）
 *     CONNECT 到真实主机，再双向 pipe。
 *
 * 由于 native http2 / undici / 任何 TLS 连接最终都调用 `net.Socket.prototype.connect`，
 * 这一层补丁能「传输无关」地覆盖 SDK 的全部出网连接，是当前唯一可靠的方案。
 */

interface SocksTarget {
  host: string
  port: number
}

let installed = false

function isLocal(host: string | undefined): boolean {
  if (!host) return true
  return (
    host === '127.0.0.1'
    || host === 'localhost'
    || host === '::1'
    || host === '0.0.0.0'
    || host.startsWith('127.')
    || host.startsWith('192.168.')
    || host.startsWith('10.')
    || host.startsWith('172.16.')
    || host.endsWith('.local')
  )
}

/** 从 ClientHello 中提取 SNI 主机名；失败返回 null。 */
function extractSni(buf: Buffer): string | null {
  try {
    if (buf.length < 5 || buf[0] !== 0x16) return null
    let offset = 5
    if (buf[offset] !== 0x01) return null
    offset += 4 + 2 + 32
    const sidLen = buf[offset]; offset += 1 + sidLen
    const csLen = buf.readUInt16BE(offset); offset += 2 + csLen
    const cmLen = buf[offset]; offset += 1 + cmLen
    if (offset + 2 > buf.length) return null
    const extLen = buf.readUInt16BE(offset); offset += 2
    const extEnd = offset + extLen
    while (offset + 4 <= extEnd) {
      const type = buf.readUInt16BE(offset)
      const len = buf.readUInt16BE(offset + 2)
      offset += 4
      if (type === 0x0000 && len > 2) {
        let pos = offset + 2
        if (pos + 3 <= offset + len) {
          const nameType = buf[pos]; pos++
          const nameLen = buf.readUInt16BE(pos); pos += 2
          if (nameType === 0x00 && pos + nameLen <= buf.length)
            return buf.subarray(pos, pos + nameLen).toString('ascii')
        }
      }
      offset += len
    }
  }
  catch { /* ignore */ }
  return null
}

/** 经 SOCKS5 与目标建立隧道；回调拿到已连通的 socket。 */
function socks5Connect(
  socks: SocksTarget,
  targetHost: string,
  targetPort: number,
  callback: (err: Error | null, socket?: net.Socket) => void,
): void {
  const socket = net.connect(socks.port, socks.host, () => {
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
    let phase: 'greeting' | 'connect' = 'greeting'
    const handler = (data: Buffer) => {
      if (phase === 'greeting') {
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
          socket.removeListener('data', handler)
          socket.destroy()
          callback(new Error('SOCKS5 auth failed'))
          return
        }
        phase = 'connect'
        const hostBuf = Buffer.from(targetHost, 'utf8')
        const portBuf = Buffer.alloc(2)
        portBuf.writeUInt16BE(targetPort)
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf,
        ]))
      }
      else {
        socket.removeListener('data', handler)
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
          socket.destroy()
          callback(new Error(`SOCKS5 connect ${targetHost}:${targetPort} failed`))
          return
        }
        callback(null, socket)
      }
    }
    socket.on('data', handler)
  })
  socket.on('error', err => callback(err))
}

/**
 * 安装 net 层透明代理补丁。幂等：重复调用只生效一次。
 * @param proxyUrl 形如 `http://127.0.0.1:7890` / `socks5://127.0.0.1:7890`；
 *   仅取其 host/port 当作 SOCKS5 端点（FlClash 混合端口同时支持 http/socks5）。
 * @returns 在本地 SNI 代理 listening 后 resolve，确保后续连接可被改道。
 */
export function applySocksProxyPatch(proxyUrl: string): Promise<void> {
  if (installed) return Promise.resolve()
  installed = true

  let socks: SocksTarget
  try {
    const u = new URL(proxyUrl)
    socks = { host: u.hostname || '127.0.0.1', port: Number(u.port) || 7890 }
  }
  catch {
    socks = { host: '127.0.0.1', port: 7890 }
  }

  // 记录「连到 SNI 代理的本地端口 → 原始目标端口」，供 SNI 代理还原真实端口。
  const portMap = new Map<number, number>()

  const sniProxy = net.createServer({ pauseOnConnect: true }, (client) => {
    client.once('data', (firstChunk: Buffer) => {
      const targetPort = portMap.get(client.remotePort ?? -1) ?? 443
      if (client.remotePort != null) portMap.delete(client.remotePort)
      const sni = extractSni(firstChunk)
      if (!sni) {
        client.destroy()
        return
      }
      socks5Connect(socks, sni, targetPort, (err, tunnel) => {
        if (err || !tunnel) {
          client.destroy()
          return
        }
        tunnel.write(firstChunk)
        client.pipe(tunnel)
        tunnel.pipe(client)
        tunnel.on('error', () => client.destroy())
        client.on('error', () => tunnel.destroy())
        client.resume()
      })
    })
    client.resume()
  })

  const origConnect = net.Socket.prototype.connect
  // monkey-patch 本质动态：对 origConnect 用宽松调用，避免 overload 类型噪音。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origCall = origConnect as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    let host: string | undefined
    let port: number | undefined
    if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
      host = args[0].host
      port = args[0].port
    }
    else if (typeof args[0] === 'number') {
      port = args[0]
      host = typeof args[1] === 'string' ? args[1] : undefined
    }
    else {
      return origCall.apply(this, args)
    }

    const targetHost = host || '127.0.0.1'
    if (!port || isLocal(targetHost))
      return origCall.apply(this, args)

    const self = this
    const localPort = (sniProxy.address() as net.AddressInfo | null)?.port
    // SNI 代理尚未 listening（理论上不会发生，applySocksProxyPatch 已 await）→ 直连兜底。
    if (!localPort)
      return origCall.apply(this, args)

    const proxyOpts = { port: localPort, host: '127.0.0.1' }
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
    const result = cb ? origCall.call(self, proxyOpts, cb) : origCall.call(self, proxyOpts)
    self.once('connect', () => {
      if (self.localPort) portMap.set(self.localPort, port)
    })
    return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any

  return new Promise<void>((resolve) => {
    sniProxy.once('error', (err: NodeJS.ErrnoException) => {
      // 端口分配失败极罕见；resolve 让流程继续（connect 改道会因无 localPort 而直连兜底）。
      if (err) resolve()
    })
    sniProxy.listen(0, '127.0.0.1', () => {
      sniProxy.unref()
      resolve()
    })
  })
}
