import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface LarkIdentity {
  userId: string
  userName: string
  tokenStatus: string
  expiresAt: string | null
  appId: string | null
}

export interface LarkIdentityResult {
  installed: boolean
  loggedIn: boolean
  identity: LarkIdentity | null
  error: string | null
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export const useLarkIdentityStore = defineStore('lark-identity', () => {
  const status = ref<LarkIdentityResult | null>(null)
  const refreshing = ref(false)
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    refreshing.value = true
    try {
      status.value = await rpc<LarkIdentityResult>('review.checkLarkIdentity', {})
    }
    catch (err) {
      status.value = { installed: false, loggedIn: false, identity: null, error: err instanceof Error ? err.message : String(err) }
    }
    finally {
      refreshing.value = false
    }
  }

  function startAutoRefresh(): void {
    if (timer) return
    void refresh()
    timer = setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
  }

  function stopAutoRefresh(): void {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { status, refreshing, refresh, startAutoRefresh, stopAutoRefresh }
})
