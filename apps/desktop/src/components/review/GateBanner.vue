<script setup lang="ts">
import { ref } from 'vue'
import { useReviewStore } from '../../stores/review'
import { setReviewServerBaseUrl, reviewServerBaseUrl } from '../../composables/use-review-server'

const store = useReviewStore()

const baseUrl = ref(reviewServerBaseUrl.value)
const reconnecting = ref(false)

async function applyBaseUrl(): Promise<void> {
  reconnecting.value = true
  try {
    setReviewServerBaseUrl(baseUrl.value)
    store.baseUrl = baseUrl.value
    await store.refreshReviewServerHealth()
  }
  finally {
    reconnecting.value = false
  }
}

async function recheckLark(): Promise<void> {
  await store.refreshLarkIdentity()
}

async function recheckMeegle(): Promise<void> {
  await store.refreshMeegleStatus()
}
</script>

<template>
  <div class="space-y-3">
    <div class="px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 text-sm">
      <div class="font-semibold mb-2">前置依赖未就绪</div>
      <ul class="list-disc pl-5 space-y-0.5 text-[13px]">
        <li v-for="r in store.blocking.reasons" :key="r">{{ r }}</li>
      </ul>
    </div>

    <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
      <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200 mb-2">1. 评审中心服务地址</div>
      <div class="flex gap-2 items-center">
        <input
          v-model="baseUrl"
          class="flex-1 px-2 py-1.5 text-[13px] rounded-md border border-gray-200 dark:border-white/10 bg-transparent"
          placeholder="http://localhost:4100"
        >
        <button
          class="px-3 py-1.5 text-[13px] rounded-md bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
          :disabled="reconnecting"
          @click="applyBaseUrl"
        >
          {{ reconnecting ? '检测中…' : '连接' }}
        </button>
      </div>
      <div class="mt-1 text-[12px]" :class="store.reviewServer.healthy ? 'text-emerald-600' : 'text-rose-600'">
        状态：{{ store.reviewServer.healthy ? '已连通' : (store.reviewServer.error ?? '未检测') }}
      </div>
      <p class="mt-1 text-[11px] text-gray-400">
        通过 Docker 部署：<code class="px-1 bg-gray-100 dark:bg-white/10 rounded">cd packages/review-server && docker compose up -d</code>
      </p>
    </div>

    <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
      <div class="flex items-center justify-between mb-2">
        <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">2. lark-cli 身份</div>
        <button
          class="px-2 py-0.5 text-[11px] rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
          @click="recheckLark"
        >
          重新检测
        </button>
      </div>
      <div v-if="!store.lark" class="text-[12px] text-gray-500">检测中…</div>
      <template v-else>
        <div v-if="!store.lark.installed" class="text-[12px] text-rose-600">
          未检测到 lark-cli。请先安装：
          <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">npm i -g @larksuiteoapi/cli</code>
        </div>
        <div v-else-if="!store.lark.loggedIn" class="space-y-1">
          <div class="text-[12px] text-rose-600">{{ store.lark.error }}</div>
          <div class="text-[12px] text-gray-500">请在终端执行 <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">lark-cli auth login</code> 完成登录后点击「重新检测」。</div>
        </div>
        <div v-else class="text-[12px] text-emerald-600">
          已登录 · {{ store.lark.identity?.userName }} ({{ store.lark.identity?.userId }})
        </div>
      </template>
    </div>

    <div class="px-4 py-3 rounded-lg bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10">
      <div class="flex items-center justify-between mb-2">
        <div class="text-[13px] font-semibold text-gray-700 dark:text-gray-200">3. meegle CLI 登录态</div>
        <button
          class="px-2 py-0.5 text-[11px] rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5"
          @click="recheckMeegle"
        >
          重新检测
        </button>
      </div>
      <div v-if="!store.meegle" class="text-[12px] text-gray-500">检测中…</div>
      <template v-else>
        <div v-if="!store.meegle.installed" class="text-[12px] text-rose-600">
          未检测到 meegle CLI。请先安装：
          <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">npm i -g meegle-cli</code>
        </div>
        <div v-else-if="!store.meegle.authenticated" class="space-y-1">
          <div class="text-[12px] text-rose-600">{{ store.meegle.error ?? '未登录' }}</div>
          <div class="text-[12px] text-gray-500">请在终端执行 <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">meegle auth login --host project.feishu.cn</code> 后点击「重新检测」。</div>
        </div>
        <div v-else class="text-[12px] text-emerald-600">
          已登录 · {{ store.meegle.host ?? 'project.feishu.cn' }}
          <span v-if="store.meegle.expiresInMinutes != null" class="text-gray-500 ml-1">(剩余 {{ store.meegle.expiresInMinutes }} 分钟)</span>
        </div>
      </template>
    </div>
  </div>
</template>
