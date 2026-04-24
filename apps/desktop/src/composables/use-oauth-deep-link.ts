import { isTauri } from '@tauri-apps/api/core'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { rpc } from './use-sidecar'

const OAUTH_CALLBACK_PREFIX = 'code-agent://oauth/callback'

let initialized = false

async function forwardOAuthCallback(urls: string[] | null | undefined): Promise<void> {
  for (const url of urls ?? []) {
    if (!url.startsWith(OAUTH_CALLBACK_PREFIX)) continue
    try {
      await rpc('mcp.oauthComplete', { url })
    }
    catch (error) {
      console.error('Failed to forward OAuth deep link callback:', error)
    }
  }
}

export async function initOAuthDeepLinkBridge(): Promise<void> {
  if (initialized || !isTauri()) return
  initialized = true

  await forwardOAuthCallback(await getCurrent())
  await onOpenUrl((urls) => {
    void forwardOAuthCallback(urls)
  })
}
