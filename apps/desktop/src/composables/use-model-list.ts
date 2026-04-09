import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { rpc } from './use-sidecar'

export interface ModelOption {
  id: string
  label: string
}

const cache = ref<Record<string, ModelOption[]>>({})
const inflightKeys = new Set<string>()

async function fetchByProvider(provider: string): Promise<ModelOption[]> {
  const key = provider || '_global'

  if (cache.value[key]?.length)
    return cache.value[key]

  if (inflightKeys.has(key))
    return []

  inflightKeys.add(key)
  try {
    const params = provider ? { provider } : undefined
    const res = await rpc<{ models: ModelOption[] }>('agent.listModels', params)
    const models = res?.models ?? []
    cache.value = { ...cache.value, [key]: models }
    return models
  }
  catch {
    return []
  }
  finally {
    inflightKeys.delete(key)
  }
}

export function invalidateModelsCache(provider?: string) {
  if (provider) {
    const copy = { ...cache.value }
    delete copy[provider]
    cache.value = copy
  }
  else {
    cache.value = {}
  }
}

export function useModelList(activeProvider: Ref<string> | ComputedRef<string>) {
  const loading = ref(false)

  const models = computed<ModelOption[]>(() => {
    const key = activeProvider.value || '_global'
    return cache.value[key] ?? []
  })

  async function fetchModels(provider?: string) {
    const p = provider ?? activeProvider.value
    loading.value = true
    try {
      await fetchByProvider(p)
    }
    finally {
      loading.value = false
    }
  }

  async function refreshModels(provider?: string) {
    const p = provider ?? activeProvider.value
    invalidateModelsCache(p)
    await fetchModels(p)
  }

  return { models, loading, fetchModels, refreshModels }
}
