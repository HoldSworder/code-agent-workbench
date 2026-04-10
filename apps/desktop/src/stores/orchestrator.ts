import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface OrchestratorStatus {
  running: boolean
  teamName: string
  roles: string[]
}

export interface OrchestratorRun {
  id: string
  requirement_id: string
  team_config: string
  status: string
  leader_decision: string | null
  reject_feedback: string | null
  created_at: string
  completed_at: string | null
}

export interface Assignment {
  id: string
  run_id: string
  role: string
  title: string
  description: string
  acceptance_criteria: string | null
  worktree_path: string | null
  branch_name: string | null
  status: string
  agent_provider: string | null
  agent_model: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export interface OrchestratorEvent {
  id: number
  run_id: string
  assignment_id: string | null
  event_type: string
  payload: string | null
  created_at: string
}

export interface RoleInput {
  description: string
  provider: string
  model?: string
  prompt_template?: string
  prompt_file?: string
}

export interface TeamConfigInput {
  name: string
  description?: string
  polling: { interval_seconds: number, board_filter?: { status?: string } }
  roles: Record<string, RoleInput>
}

export interface AgentCatalogItem {
  path: string
  category: string
  filename: string
}

export interface AgentCatalog {
  categories: Record<string, AgentCatalogItem[]>
}

export interface AgentPromptDetail {
  name: string
  description: string
  emoji: string
  prompt: string
}

export const useOrchestratorStore = defineStore('orchestrator', () => {
  const status = ref<OrchestratorStatus | null>(null)
  const runs = ref<OrchestratorRun[]>([])
  const selectedRun = ref<OrchestratorRun | null>(null)
  const selectedRunAssignments = ref<Assignment[]>([])
  const events = ref<OrchestratorEvent[]>([])
  const teamConfig = ref<TeamConfigInput | null>(null)
  const loading = ref(false)

  const isRunning = computed(() => status.value?.running ?? false)

  async function fetchStatus() {
    try {
      status.value = await rpc<OrchestratorStatus>('orchestrator.status')
    }
    catch {
      status.value = null
    }
  }

  async function start() {
    await rpc('orchestrator.start')
    await fetchStatus()
  }

  async function stop() {
    await rpc('orchestrator.stop')
    await fetchStatus()
  }

  async function fetchRuns() {
    loading.value = true
    try {
      runs.value = await rpc<OrchestratorRun[]>('orchestrator.getRuns', { limit: 100 })
    }
    finally {
      loading.value = false
    }
  }

  async function fetchRunDetail(runId: string) {
    const result = await rpc<{ run: OrchestratorRun, assignments: Assignment[] }>('orchestrator.getRunDetail', { runId })
    selectedRun.value = result.run
    selectedRunAssignments.value = result.assignments
  }

  async function fetchEvents(runId?: string) {
    const lastId = events.value.length > 0 ? events.value[events.value.length - 1].id : 0
    const newEvents = await rpc<OrchestratorEvent[]>('orchestrator.getEvents', {
      runId,
      afterId: lastId,
      limit: 200,
    })
    if (newEvents.length > 0) {
      events.value = [...events.value, ...newEvents]
    }
  }

  async function cancelRun(runId: string) {
    await rpc('orchestrator.cancelRun', { runId })
    await fetchRuns()
    if (selectedRun.value?.id === runId) {
      await fetchRunDetail(runId)
    }
  }

  async function rejectRun(runId: string, feedback: string) {
    await rpc('orchestrator.rejectRun', { runId, feedback })
    await fetchRuns()
    if (selectedRun.value?.id === runId) {
      await fetchRunDetail(runId)
    }
  }

  async function retryAssignment(assignmentId: string) {
    await rpc('orchestrator.retryAssignment', { assignmentId })
    if (selectedRun.value) {
      await fetchRunDetail(selectedRun.value.id)
    }
  }

  function clearSelection() {
    selectedRun.value = null
    selectedRunAssignments.value = []
    events.value = []
  }

  const agencyCatalog = ref<AgentCatalog | null>(null)
  const catalogLoading = ref(false)

  const configError = ref('')

  async function fetchTeamConfig() {
    configError.value = ''
    try {
      const result = await rpc<TeamConfigInput | null>('orchestrator.getTeamConfig')
      teamConfig.value = result
    }
    catch (err) {
      teamConfig.value = null
      configError.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function saveTeamConfig(config: TeamConfigInput) {
    await rpc('orchestrator.saveTeamConfig', config)
    teamConfig.value = config
    await fetchStatus()
  }

  async function createDefaultConfig() {
    await rpc('orchestrator.createDefaultConfig')
    await fetchTeamConfig()
  }

  async function fetchAgencyCatalog() {
    catalogLoading.value = true
    try {
      agencyCatalog.value = await rpc<AgentCatalog>('orchestrator.getAgencyCatalog')
    }
    finally {
      catalogLoading.value = false
    }
  }

  async function fetchAgentPrompt(path: string): Promise<AgentPromptDetail> {
    return rpc<AgentPromptDetail>('orchestrator.getAgentPrompt', { path })
  }

  return {
    status,
    runs,
    selectedRun,
    selectedRunAssignments,
    events,
    teamConfig,
    configError,
    loading,
    isRunning,
    agencyCatalog,
    catalogLoading,
    fetchStatus,
    start,
    stop,
    fetchRuns,
    fetchRunDetail,
    fetchEvents,
    cancelRun,
    rejectRun,
    retryAssignment,
    clearSelection,
    fetchTeamConfig,
    saveTeamConfig,
    createDefaultConfig,
    fetchAgencyCatalog,
    fetchAgentPrompt,
  }
})
