import { getMeegleAuthStatus, type MeegleAuthResult } from '@code-agent/shared/meegle'
import { listViewItems, type ListViewItemsResult } from '../review/meegle-view'
import type { RpcServer } from './server'

/**
 * 注册「飞书项目」独立页面所需 RPC：通过 meegle-cli 子进程，与飞书项目 MCP 链路并行存在。
 * 不复用 review.* 命名空间，避免与现有评审流程的状态耦合。
 */
export function registerFeishuProjectMethods(server: RpcServer): void {
  server.register('feishuProject.checkAuth', async (): Promise<MeegleAuthResult> => {
    return getMeegleAuthStatus()
  })

  server.register('feishuProject.listViewItems', async (params: {
    projectKey: string
    workItemType: string
    viewId: string
    pageNum?: number
  }): Promise<ListViewItemsResult> => {
    return listViewItems(params)
  })
}
