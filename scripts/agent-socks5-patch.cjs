/**
 * 进程内 SNI 透明代理补丁
 *
 * 通过 NODE_OPTIONS="--require <this-file>" 注入到 Node.js CLI 进程中，
 * 将所有非本地 TCP 连接重定向到本地 SNI 代理，再经 SOCKS5 隧道转发。
 * 等效于 TUN 模式，但无需开启虚拟网卡。
 *
 * 可配置环境变量：
 *   AGENT_SOCKS5_HOST  — SOCKS5 代理地址 (默认 127.0.0.1)
 *   AGENT_SOCKS5_PORT  — SOCKS5 代理端口 (默认 7890)
 *   AGENT_SNI_PORT     — 本地 SNI 代理监听端口 (默认 17891)
 */

const net = require("net");

const SOCKS5_HOST = process.env.AGENT_SOCKS5_HOST || "127.0.0.1";
const SOCKS5_PORT = Number(process.env.AGENT_SOCKS5_PORT) || 7890;
const LOCAL_PROXY_PORT = Number(process.env.AGENT_SNI_PORT) || 17891;

const portMap = new Map();

function isLocal(host) {
  return (
    !host || host === "127.0.0.1" || host === "localhost" || host === "::1" ||
    host === "0.0.0.0" || host.startsWith("127.") || host.startsWith("192.168.") || host.startsWith("10.")
  );
}

function extractSNI(buf) {
  try {
    if (buf.length < 5 || buf[0] !== 0x16) return null;
    let offset = 5;
    if (buf[offset] !== 0x01) return null;
    offset += 4 + 2 + 32;
    const sidLen = buf[offset]; offset += 1 + sidLen;
    const csLen = buf.readUInt16BE(offset); offset += 2 + csLen;
    const cmLen = buf[offset]; offset += 1 + cmLen;
    if (offset + 2 > buf.length) return null;
    const extLen = buf.readUInt16BE(offset); offset += 2;
    const extEnd = offset + extLen;
    while (offset + 4 <= extEnd) {
      const type = buf.readUInt16BE(offset);
      const len = buf.readUInt16BE(offset + 2);
      offset += 4;
      if (type === 0x0000 && len > 2) {
        let pos = offset + 2;
        if (pos + 3 <= offset + len) {
          const nameType = buf[pos]; pos++;
          const nameLen = buf.readUInt16BE(pos); pos += 2;
          if (nameType === 0x00 && pos + nameLen <= buf.length) {
            return buf.subarray(pos, pos + nameLen).toString("ascii");
          }
        }
      }
      offset += len;
    }
  } catch { /* ignore parse errors */ }
  return null;
}

function socks5Connect(targetHost, targetPort, callback) {
  const socket = net.connect(SOCKS5_PORT, SOCKS5_HOST, () => {
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    let phase = "greeting";
    const handler = (data) => {
      if (phase === "greeting") {
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
          socket.removeListener("data", handler);
          socket.destroy();
          return callback(new Error("SOCKS5 auth failed"));
        }
        phase = "connect";
        const hostBuf = Buffer.from(targetHost, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(targetPort);
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf,
        ]));
      } else if (phase === "connect") {
        socket.removeListener("data", handler);
        if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
          socket.destroy();
          return callback(new Error(`SOCKS5 connect ${targetHost}:${targetPort} failed`));
        }
        callback(null, socket);
      }
    };
    socket.on("data", handler);
  });
  socket.on("error", (err) => callback(err));
}

const sniProxy = net.createServer({ pauseOnConnect: true }, (client) => {
  client.once("data", (firstChunk) => {
    const targetPort = portMap.get(client.remotePort) || 443;
    portMap.delete(client.remotePort);
    const sni = extractSNI(firstChunk);
    if (!sni) { client.destroy(); return; }
    socks5Connect(sni, targetPort, (err, tunnel) => {
      if (err) { client.destroy(); return; }
      tunnel.write(firstChunk);
      client.pipe(tunnel);
      tunnel.pipe(client);
      tunnel.on("error", () => client.destroy());
      client.on("error", () => tunnel.destroy());
      client.resume();
    });
  });
  client.resume();
});

sniProxy.listen(LOCAL_PROXY_PORT, "127.0.0.1");
sniProxy.on("error", (err) => {
  if (err.code === "EADDRINUSE") sniProxy.close();
});
sniProxy.unref();

const origConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  let options;
  if (typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
    options = args[0];
  } else if (typeof args[0] === "number") {
    options = { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
  } else {
    return origConnect.apply(this, args);
  }

  const host = options.host || "127.0.0.1";
  const port = options.port;

  if (!port || isLocal(host)) {
    return origConnect.apply(this, args);
  }

  const self = this;
  const proxyOpts = { port: LOCAL_PROXY_PORT, host: "127.0.0.1" };
  const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;

  const result = cb
    ? origConnect.call(self, proxyOpts, cb)
    : origConnect.call(self, proxyOpts);

  self.once("connect", () => {
    if (self.localPort) portMap.set(self.localPort, port);
  });

  return result;
};
