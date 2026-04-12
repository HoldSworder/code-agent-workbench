import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface Repo {
  id: string
  name: string
  alias: string | null
  local_path: string
  default_branch: string
  agent_provider: string | null
  created_at: string
}

export const useReposStore = defineStore('repos', () => {
  const repos = ref<Repo[]>([])
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try { repos.value = await rpc<Repo[]>('repo.list') }
    finally { loading.value = false }
  }

  async function create(input: { name: string, alias?: string, local_path: string, default_branch: string }) {
    const repo = await rpc<Repo>('repo.create', input)
    repos.value.unshift(repo)
    return repo
  }

  async function update(id: string, input: { name?: string, alias?: string | null, default_branch?: string }) {
    const repo = await rpc<Repo>('repo.update', { id, ...input })
    const idx = repos.value.findIndex(r => r.id === id)
    if (idx !== -1) repos.value[idx] = repo
    return repo
  }

  async function remove(id: string) {
    await rpc('repo.delete', { id })
    repos.value = repos.value.filter(r => r.id !== id)
  }

  return { repos, loading, fetchAll, create, update, remove }
})
