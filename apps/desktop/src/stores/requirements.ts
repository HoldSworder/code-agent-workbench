import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface Requirement {
  id: string
  title: string
  description: string
  source: string
  source_url: string | null
  doc_url: string | null
  status: string
  mode: string
  created_at: string
}

export interface CreateRequirementInput {
  title?: string
  description: string
  source: string
  source_url?: string
  doc_url?: string
  mode?: 'workflow' | 'orchestrator'
}

export const useRequirementsStore = defineStore('requirements', () => {
  const requirements = ref<Requirement[]>([])
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try { requirements.value = await rpc<Requirement[]>('requirement.list') }
    finally { loading.value = false }
  }

  async function create(input: CreateRequirementInput) {
    const req = await rpc<Requirement>('requirement.create', input)
    requirements.value.unshift(req)
    return req
  }

  async function remove(id: string) {
    await rpc<{ ok: boolean }>('requirement.delete', { id })
    requirements.value = requirements.value.filter(r => r.id !== id)
  }

  return { requirements, loading, fetchAll, create, remove }
})
