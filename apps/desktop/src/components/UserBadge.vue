<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useLarkIdentityStore } from '../stores/lark-identity'

const store = useLarkIdentityStore()
const open = ref(false)
const popoverRef = ref<HTMLDivElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)

const badgeText = computed(() => {
  const id = store.status?.identity
  if (!id) return '未登录'
  return id.userName.length > 8 ? `${id.userName.slice(0, 8)}…` : id.userName
})

const initialChar = computed(() => {
  const name = store.status?.identity?.userName ?? '?'
  return name.charAt(0)
})

const stateColor = computed(() => {
  if (!store.status) return 'bg-gray-200 dark:bg-white/10 text-gray-400'
  if (!store.status.loggedIn) return 'bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300'
  return 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
})

function toggle(): void {
  open.value = !open.value
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return
  const target = ev.target as Node
  if (popoverRef.value?.contains(target) || triggerRef.value?.contains(target)) return
  open.value = false
}

async function onRecheck(): Promise<void> {
  await store.refresh()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="relative">
    <button
      ref="triggerRef"
      class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
      :title="store.status?.identity?.userId ?? store.status?.error ?? '检测中…'"
      @click="toggle"
    >
      <div
        class="w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-semibold shrink-0"
        :class="stateColor"
      >
        {{ initialChar }}
      </div>
      <div class="flex-1 min-w-0 text-left">
        <div class="text-[12px] font-medium text-gray-700 dark:text-gray-200 truncate">{{ badgeText }}</div>
        <div class="text-[10px] text-gray-400 truncate">
          {{ store.status?.loggedIn ? '已登录' : (store.status?.error ?? '未登录') }}
        </div>
      </div>
    </button>

    <Transition
      enter-active-class="transition-all duration-150"
      leave-active-class="transition-all duration-100"
      enter-from-class="opacity-0 -translate-y-1"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="open"
        ref="popoverRef"
        class="absolute z-30 left-2 right-2 top-full mt-1 px-3 py-2.5 rounded-lg bg-white dark:bg-[#28282c] shadow-lg shadow-black/[0.08] border border-gray-100 dark:border-white/10 space-y-2"
      >
        <div class="flex items-center justify-between">
          <span class="text-[12px] font-semibold text-gray-700 dark:text-gray-200">飞书身份</span>
          <button
            class="text-[10px] px-1.5 py-0.5 rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
            :disabled="store.refreshing"
            @click="onRecheck"
          >
            {{ store.refreshing ? '检测中…' : '重新检测' }}
          </button>
        </div>

        <template v-if="store.status?.loggedIn && store.status.identity">
          <div class="space-y-1 text-[11px]">
            <div class="flex justify-between gap-2">
              <span class="text-gray-400">姓名</span>
              <span class="font-medium text-gray-700 dark:text-gray-200 truncate">{{ store.status.identity.userName }}</span>
            </div>
            <div class="flex justify-between gap-2">
              <span class="text-gray-400">User ID</span>
              <span class="font-mono text-gray-500 truncate">{{ store.status.identity.userId }}</span>
            </div>
            <div v-if="store.status.identity.appId" class="flex justify-between gap-2">
              <span class="text-gray-400">App ID</span>
              <span class="font-mono text-gray-500 truncate">{{ store.status.identity.appId }}</span>
            </div>
            <div class="flex justify-between gap-2">
              <span class="text-gray-400">Token</span>
              <span class="text-emerald-600 dark:text-emerald-400">{{ store.status.identity.tokenStatus }}</span>
            </div>
            <div v-if="store.status.identity.expiresAt" class="flex justify-between gap-2">
              <span class="text-gray-400">过期</span>
              <span class="text-gray-500 truncate">{{ store.status.identity.expiresAt }}</span>
            </div>
          </div>
        </template>

        <template v-else>
          <p v-if="!store.status" class="text-[11px] text-gray-400">检测中…</p>
          <div v-else-if="!store.status.installed" class="text-[11px] text-rose-500 leading-relaxed">
            未检测到 lark-cli。请先安装：<br>
            <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">npm i -g @larksuiteoapi/cli</code>
          </div>
          <div v-else class="text-[11px] text-rose-500 leading-relaxed">
            <div>{{ store.status.error ?? '未登录' }}</div>
            <div class="mt-1 text-gray-400">
              请在终端执行 <code class="px-1 bg-gray-100 dark:bg-white/10 rounded">lark-cli auth login</code>
            </div>
          </div>
        </template>
      </div>
    </Transition>
  </div>
</template>
