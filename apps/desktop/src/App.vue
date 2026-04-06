<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useReposStore } from './stores/repos'
import { startSidecar, sidecarReady } from './composables/use-sidecar'

const route = useRoute()
const reposStore = useReposStore()

onMounted(async () => {
  await startSidecar()
  reposStore.fetchAll()
})
</script>

<template>
  <div class="flex h-screen bg-[#f5f5f7] dark:bg-[#1a1a1e] text-gray-900 dark:text-gray-100">
    <nav class="w-52 bg-[#ebebee]/80 dark:bg-[#28282c] flex flex-col backdrop-blur-xl">
      <div class="px-5 pt-6 pb-4">
        <h1 class="text-base font-semibold tracking-tight text-gray-800 dark:text-gray-200">Code Agent</h1>
      </div>
      <div class="flex-1 overflow-y-auto px-2">
        <router-link
          to="/"
          class="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-all duration-150"
          :class="route.path === '/'
            ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white font-medium shadow-sm'
            : 'text-gray-600 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-white/5'"
        >
          <div class="i-carbon-dashboard w-4 h-4 opacity-60" />
          总看板
        </router-link>

        <div class="px-3 mt-5 mb-1.5 text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
          仓库
        </div>
        <router-link
          v-for="repo in reposStore.repos"
          :key="repo.id"
          :to="`/repo/${repo.id}`"
          class="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-all duration-150 text-gray-600 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-white/5"
          active-class="!bg-white dark:!bg-white/10 !text-gray-900 dark:!text-white font-medium shadow-sm"
        >
          <div class="i-carbon-folder-details w-4 h-4 opacity-60" />
          {{ repo.name }}
        </router-link>
      </div>

      <div class="px-2 pb-3">
        <router-link
          to="/settings"
          class="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-all duration-150 text-gray-500 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-white/5"
          active-class="!bg-white dark:!bg-white/10 !text-gray-900 dark:!text-white font-medium shadow-sm"
        >
          <div class="i-carbon-settings w-4 h-4 opacity-60" />
          设置
        </router-link>
      </div>
    </nav>

    <main class="flex-1 overflow-y-auto">
      <router-view v-if="sidecarReady" />
      <div v-else class="flex items-center justify-center h-full">
        <div class="flex items-center gap-3 text-gray-400 text-sm">
          <div class="w-4 h-4 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
          正在启动服务…
        </div>
      </div>
    </main>
  </div>
</template>
