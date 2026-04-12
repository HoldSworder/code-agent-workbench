<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchRepos, fetchStatus, type Repo } from './composables/use-api'
import RepoSelector from './components/RepoSelector.vue'
import ChatView from './components/ChatView.vue'

const repos = ref<Repo[]>([])
const loading = ref(true)
const selectedRepoId = ref<string | null>(null)
const sidebarOpen = ref(true)
const lanUrl = ref<string | null>(null)

const selectedRepo = computed(() =>
  repos.value.find(r => r.id === selectedRepoId.value) ?? null,
)

onMounted(async () => {
  try {
    const [repoList, status] = await Promise.all([fetchRepos(), fetchStatus()])
    repos.value = repoList
    lanUrl.value = status.lanUrl
    if (repoList.length === 1) {
      selectedRepoId.value = repoList[0].id
    }
  } catch {
    try { repos.value = await fetchRepos() } catch {}
  } finally {
    loading.value = false
  }
})

function selectRepo(id: string) {
  selectedRepoId.value = id
  if (window.innerWidth < 768) sidebarOpen.value = false
}
</script>

<template>
  <div class="flex w-screen h-screen overflow-hidden bg-gradient-to-br from-slate-50 via-gray-50 to-zinc-100 dark:from-[#141416] dark:via-[#18181b] dark:to-[#1c1c20] text-gray-900 dark:text-gray-100">
    <!-- Mobile sidebar toggle -->
    <button
      class="md:hidden fixed top-3 left-3 z-50 w-9 h-9 rounded-lg bg-white/80 dark:bg-[#28282c]/80 backdrop-blur-lg shadow-sm flex items-center justify-center"
      @click="sidebarOpen = !sidebarOpen"
    >
      <div :class="sidebarOpen ? 'i-carbon-close' : 'i-carbon-menu'" class="w-4 h-4 text-gray-500 dark:text-gray-400" />
    </button>

    <!-- Sidebar -->
    <aside
      class="shrink-0 transition-all duration-300 ease-out overflow-hidden"
      :class="sidebarOpen ? 'w-64' : 'w-0 md:w-64'"
    >
      <div class="h-full w-64 bg-white/60 dark:bg-[#1a1a1e]/90 backdrop-blur-xl flex flex-col border-r border-gray-200/30 dark:border-white/4">
        <!-- Branding -->
        <div class="px-4 pt-5 pb-1 flex items-center gap-2.5 shrink-0">
          <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 flex items-center justify-center shadow-sm shadow-indigo-500/20">
            <div class="i-carbon-bot w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <span class="text-[14px] font-bold tracking-tight bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">Code Agent</span>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span class="text-[10px] text-gray-400 dark:text-gray-500 font-medium">只读咨询</span>
            </div>
          </div>
        </div>

        <!-- LAN access info -->
        <div v-if="lanUrl" class="mx-4 mt-2 px-2.5 py-1.5 rounded-md bg-indigo-50/50 dark:bg-indigo-500/6 shrink-0">
          <div class="flex items-center gap-1 text-[10px] text-indigo-400 dark:text-indigo-400/60 font-medium mb-0.5">
            <div class="i-carbon-network-4 w-3 h-3" />
            局域网访问
          </div>
          <a
            :href="lanUrl"
            target="_blank"
            class="text-[11px] font-mono text-indigo-500 dark:text-indigo-400 hover:underline break-all leading-tight"
          >{{ lanUrl }}</a>
        </div>

        <div class="mx-4 mt-3 mb-3 h-px bg-gray-200/40 dark:bg-white/5 shrink-0" />

        <RepoSelector
          :repos="repos"
          :selected-id="selectedRepoId"
          :loading="loading"
          @select="selectRepo"
        />
      </div>
    </aside>

    <!-- Main -->
    <main class="flex-1 min-w-0 h-full overflow-hidden">
      <ChatView
        v-if="selectedRepo"
        :repo-id="selectedRepo.id"
        :repo-name="selectedRepo.alias || selectedRepo.name"
      />
      <div v-else class="flex flex-col items-center justify-center h-full text-center px-6">
        <div class="relative mb-5">
          <div class="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-100 via-violet-50 to-purple-100 dark:from-indigo-500/12 dark:via-violet-500/8 dark:to-purple-500/12 flex items-center justify-center">
            <div class="i-carbon-chat w-9 h-9 text-indigo-400 dark:text-indigo-400" />
          </div>
          <div class="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-white dark:bg-[#1e1e22] shadow-sm flex items-center justify-center">
            <div class="i-carbon-arrow-left w-3.5 h-3.5 text-indigo-500" />
          </div>
        </div>
        <h2 class="text-lg font-bold text-gray-800 dark:text-gray-200 mb-1.5">选择一个项目</h2>
        <p class="text-[13px] text-gray-400 dark:text-gray-500 max-w-xs leading-relaxed">
          从左侧列表选择代码仓库，开始咨询架构与代码问题
        </p>
      </div>
    </main>
  </div>
</template>
