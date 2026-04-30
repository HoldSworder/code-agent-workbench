<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useReviewStore, type SessionDto } from '../../stores/review'
import { rpc } from '../../composables/use-sidecar'

const route = useRoute()
const router = useRouter()
const store = useReviewStore()

const stage = ref<'preparing' | 'creating-doc' | 'creating-session' | 'failed'>('preparing')
const errMsg = ref<string | null>(null)

interface CreateDocResult { token: string, url: string }

async function ensureFeishuSpecDoc(title: string): Promise<CreateDocResult | null> {
  stage.value = 'creating-doc'
  try {
    return await rpc<CreateDocResult>('review.feishuDocCreate', {
      title: `开发设计 - ${title}`,
      content: `# 前端开发设计 - ${title}\n\n（评审中…）`,
    })
  }
  catch (err) {
    errMsg.value = `创建飞书文档失败：${err instanceof Error ? err.message : String(err)}`
    return null
  }
}

/**
 * 中转流程：从 query 拿 workItemId/title/url/repos，
 * 先建飞书 spec 文档（用于沉淀 design.md），再调 review.createSession，
 * 拿到 sessionId 后 router.replace 到详情页。
 *
 * 失败时停在本页展示错误，便于用户回到列表页修正。
 */
async function bootstrap(): Promise<void> {
  await store.refreshAll()
  if (store.blocking.blocked) {
    errMsg.value = `前置依赖未通过：${store.blocking.reasons.join('；')}`
    stage.value = 'failed'
    return
  }
  if (!store.lark?.identity) {
    errMsg.value = 'lark-cli 身份缺失，请先回到列表页点击「重新检测」'
    stage.value = 'failed'
    return
  }

  const workItemId = String(route.query.workItemId ?? '').trim()
  const title = String(route.query.title ?? '').trim()
  const workItemUrl = String(route.query.url ?? '').trim()
  const reposCsv = String(route.query.repos ?? '').trim()
  const relatedRepos = reposCsv ? reposCsv.split('|').filter(Boolean) : []

  if (!workItemId || !title) {
    errMsg.value = '缺少必要参数 workItemId/title，请回到列表页重新选择'
    stage.value = 'failed'
    return
  }
  if (relatedRepos.length === 0) {
    errMsg.value = '缺少关联仓库，请回到列表页勾选至少一个仓库'
    stage.value = 'failed'
    return
  }

  const docInfo = await ensureFeishuSpecDoc(title)
  if (!docInfo) { stage.value = 'failed'; return }

  stage.value = 'creating-session'
  try {
    const data = await rpc<{ session: SessionDto, reused: boolean }>('review.createSession', {
      baseUrl: store.baseUrl,
      identity: {
        userId: store.lark.identity.userId,
        userName: store.lark.identity.userName,
        role: store.role,
      },
      input: {
        requirementId: workItemId,
        requirementTitle: title,
        feishuRequirementUrl: workItemUrl || undefined,
        feishuSpecDocToken: docInfo.token,
        feishuSpecDocUrl: docInfo.url,
        initialSpecMarkdown: `# 前端开发设计 - ${title}\n\n（评审中…）`,
        relatedRepos,
      },
    })
    await router.replace({ path: `/review/session/${data.session.id}` })
  }
  catch (err) {
    errMsg.value = err instanceof Error ? err.message : String(err)
    stage.value = 'failed'
  }
}

onMounted(() => { void bootstrap() })
</script>

<template>
  <div class="h-full overflow-y-auto p-5">
    <div class="max-w-3xl mx-auto space-y-3">
      <h1 class="text-lg font-semibold tracking-tight">进入评审会话</h1>

      <div class="text-[13px] text-gray-600 dark:text-gray-300 space-y-1">
        <div v-if="stage === 'preparing'">检查前置依赖…</div>
        <div v-else-if="stage === 'creating-doc'">创建飞书 design 文档…</div>
        <div v-else-if="stage === 'creating-session'">创建/复用评审会话…</div>
      </div>

      <div v-if="errMsg" class="px-4 py-3 rounded-lg border border-rose-300 dark:border-rose-700/50 bg-rose-50/40 dark:bg-rose-900/10 text-[12px] text-rose-700 dark:text-rose-300 whitespace-pre-wrap">
        {{ errMsg }}
      </div>

      <div v-if="stage === 'failed'" class="flex gap-2">
        <button
          class="px-3 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
          @click="router.replace({ path: '/review' })"
        >
          返回列表
        </button>
      </div>
    </div>
  </div>
</template>
