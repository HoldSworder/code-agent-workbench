import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

/**
 * 回环 / 内网默认不走代理，避免 review-server、本地 MCP 等回环请求被塞进代理隧道。
 */
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'

/**
 * 让「当前进程内」的 native fetch（`@cursor/sdk` 依赖 undici）真正经由代理。
 *
 * 背景：Node 的 undici 默认既不读 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，也不读
 * macOS 系统代理。因此仅设置 `process.env.HTTP_PROXY` 对 SDK 是空操作——SDK 会
 * 一直直连。要让 app 内的代理设置生效，必须显式 `setGlobalDispatcher`。
 *
 * `setGlobalDispatcher` 是进程级的：父进程与每个 fork 出来的 worker 子进程都要
 * 各自调用一次。
 *
 * @param proxyUrl 代理地址（如 `http://127.0.0.1:7890`）；为空 → 复位为直连。
 */
export function applyGlobalProxy(proxyUrl: string | undefined): void {
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? DEFAULT_NO_PROXY,
    }))
  }
  else {
    setGlobalDispatcher(new Agent())
  }
}
