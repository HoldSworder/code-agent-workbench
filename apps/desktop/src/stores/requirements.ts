import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface Requirement {
  id: string
  title: string
  description: string
  source: string
  source_url: string | null
  status: string
  created_at: string
}

export const useRequirementsStore = defineStore('requirements', () => {
  const requirements = ref<Requirement[]>([])
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try { requirements.value = await rpc<Requirement[]>('requirement.list') }
    finally { loading.value = false }
  }

  async function create(input: { title: string, description: string, source: string, source_url?: string }) {
    const req = await rpc<Requirement>('requirement.create', input)
    requirements.value.unshift(req)
    return req
  }

  return { requirements, loading, fetchAll, create }
})
