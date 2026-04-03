<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useReposStore } from './stores/repos'

const route = useRoute()
const reposStore = useReposStore()

const mockRepos = [
  { id: '1', name: 'frontend-app', local_path: '/code/frontend', default_branch: 'main', agent_provider: 'cursor', created_at: '2025-01-01' },
  { id: '2', name: 'backend-api', local_path: '/code/backend', default_branch: 'main', agent_provider: 'claude', created_at: '2025-01-02' },
  { id: '3', name: 'shared-lib', local_path: '/code/shared', default_branch: 'develop', agent_provider: null, created_at: '2025-01-03' },
]

const repos = reposStore.repos.length > 0 ? reposStore.repos : mockRepos
</script>

<template>
  <div class="flex h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
    <nav class="w-56 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col">
      <div class="px-4 py-4 border-b border-gray-200 dark:border-gray-800">
        <h1 class="text-lg font-bold tracking-tight">Code Agent</h1>
      </div>
      <div class="flex-1 overflow-y-auto py-2">
        <router-link
          to="/"
          class="flex items-center gap-2 px-4 py-2 mx-2 rounded-lg text-sm transition-colors"
          :class="route.path === '/' ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 font-medium' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'"
        >
          <div class="i-carbon-dashboard w-4 h-4" />
          总看板
        </router-link>

        <div class="px-4 mt-4 mb-1 text-xs font-medium text-gray-400 uppercase tracking-wider">
          仓库
        </div>
        <router-link
          v-for="repo in repos"
          :key="repo.id"
          :to="`/repo/${repo.id}`"
          class="flex items-center gap-2 px-4 py-2 mx-2 rounded-lg text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400"
          active-class="!bg-indigo-50 dark:!bg-indigo-950 !text-indigo-600 dark:!text-indigo-400 font-medium"
        >
          <div class="i-carbon-folder-details w-4 h-4" />
          {{ repo.name }}
        </router-link>
      </div>

      <router-link
        to="/settings"
        class="flex items-center gap-2 px-4 py-3 mx-2 mb-2 rounded-lg text-sm transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500"
        active-class="!bg-indigo-50 dark:!bg-indigo-950 !text-indigo-600 dark:!text-indigo-400"
      >
        <div class="i-carbon-settings w-4 h-4" />
        设置
      </router-link>
    </nav>

    <main class="flex-1 overflow-y-auto">
      <router-view />
    </main>
  </div>
</template>
