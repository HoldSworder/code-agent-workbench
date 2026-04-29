import { ref } from 'vue'
import { rpc } from './use-sidecar'

export interface LarkIdentityResult {
  installed: boolean
  loggedIn: boolean
  identity: {
    userId: string
    userName: string
    tokenStatus: string
    expiresAt: string | null
    appId: string | null
  } | null
  error: string | null
}

/**
 * 评审中心 baseUrl（持久化到 localStorage），由 GateBanner 暴露给用户编辑。
 *
 * 所有 review-server HTTP 请求一律通过 sidecar RPC 中转（review.listSessions / review.createSession 等），
 * 前端不再直接 fetch，避免 WKWebView 下 CORS/连接错误信息含糊不清，并把异常翻译统一收敛到 sidecar。
 */
export const reviewServerBaseUrl = ref(localStorage.getItem('review.baseUrl') ?? 'http://localhost:4100')

export function setReviewServerBaseUrl(url: string): void {
  reviewServerBaseUrl.value = url
  localStorage.setItem('review.baseUrl', url)
}

export async function checkLarkIdentity(): Promise<LarkIdentityResult> {
  return rpc<LarkIdentityResult>('review.checkLarkIdentity', {})
}
