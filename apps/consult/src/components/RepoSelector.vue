<script setup lang="ts">
import type { Repo } from '../composables/use-api'

defineProps<{
  repos: Repo[]
  selectedId: string | null
  loading: boolean
}>()

const emit = defineEmits<{
  select: [repoId: string]
}>()
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0">
    <div class="px-4 mb-2 shrink-0">
      <p class="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">项目</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-12 text-gray-400">
      <div class="w-5 h-5 border-2 border-gray-200 dark:border-gray-700 border-t-indigo-500 rounded-full animate-spin" />
    </div>

    <div v-else-if="repos.length === 0" class="flex flex-col items-center justify-center py-12 px-4 text-center">
      <div class="w-10 h-10 rounded-xl bg-gray-100 dark:bg-white/5 flex items-center justify-center mb-2.5">
        <div class="i-carbon-folder-add w-5 h-5 text-gray-300 dark:text-gray-600" />
      </div>
      <p class="text-[12px] text-gray-400 font-medium">暂无项目</p>
      <p class="text-[11px] text-gray-300 dark:text-gray-600 mt-1 leading-relaxed">请先在桌面端设置中添加仓库</p>
    </div>

    <div v-else class="flex-1 overflow-y-auto scroll-thin px-2.5 pb-3 space-y-0.5">
      <button
        v-for="repo in repos"
        :key="repo.id"
        class="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg text-left transition-all duration-150 group"
        :class="selectedId === repo.id
          ? 'bg-indigo-50/70 dark:bg-indigo-500/10'
          : 'hover:bg-gray-100/60 dark:hover:bg-white/3'"
        @click="emit('select', repo.id)"
      >
        <div
          class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-150"
          :class="selectedId === repo.id
            ? 'bg-gradient-to-br from-indigo-500 to-violet-500 shadow-sm shadow-indigo-500/20'
            : 'bg-gray-100 dark:bg-white/6 group-hover:bg-gray-200 dark:group-hover:bg-white/8'"
        >
          <div
            class="i-carbon-folder-details w-4 h-4 transition-colors"
            :class="selectedId === repo.id ? 'text-white' : 'text-gray-400 dark:text-gray-500'"
          />
        </div>
        <div class="min-w-0 flex-1">
          <div
            class="text-[13px] font-medium truncate transition-colors"
            :class="selectedId === repo.id ? 'text-indigo-600 dark:text-indigo-300' : 'text-gray-700 dark:text-gray-300'"
          >{{ repo.alias || repo.name }}</div>
          <div class="text-[10px] text-gray-400 dark:text-gray-600 truncate font-mono mt-0.5">{{ repo.local_path }}</div>
        </div>
        <div
          v-if="selectedId === repo.id"
          class="w-1 h-5 rounded-full bg-indigo-500 dark:bg-indigo-400 shrink-0"
        />
      </button>
    </div>
  </div>
</template>
