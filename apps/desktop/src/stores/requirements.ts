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
  fetch_error: string | null
  fetch_output: string | null
  fetch_prompt: string | null
  fetch_cli_type: string | null
  fetch_model: string | null
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

  async function refreshOne(id: string) {
    const req = await rpc<Requirement>('requirement.get', { id })
    if (!req) return
    const idx = requirements.value.findIndex(r => r.id === id)
    if (idx >= 0) requirements.value[idx] = req
    else requirements.value.unshift(req)
  }

  async function remove(id: string) {
    await rpc<{ ok: boolean }>('requirement.delete', { id })
    requirements.value = requirements.value.filter(r => r.id !== id)
  }

  async function updateMode(id: string, mode: 'workflow' | 'orchestrator') {
    const req = await rpc<Requirement>('requirement.update', { id, data: { mode } })
    if (!req) return
    const idx = requirements.value.findIndex(r => r.id === id)
    if (idx >= 0) requirements.value[idx] = req
  }

  async function updateStatus(id: string, status: string) {
    const req = await rpc<Requirement>('requirement.updateStatus', { id, status })
    if (!req) return
    const idx = requirements.value.findIndex(r => r.id === id)
    if (idx >= 0) requirements.value[idx] = req
  }

  async function archive(id: string) {
    const req = await rpc<Requirement>('requirement.archive', { id })
    if (!req) return
    const idx = requirements.value.findIndex(r => r.id === id)
    if (idx >= 0) requirements.value[idx] = req
  }

  return { requirements, loading, fetchAll, create, refreshOne, remove, updateMode, updateStatus, archive }
})
