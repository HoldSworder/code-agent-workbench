import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_stage: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
  workflow_id: string | null
  workflow_completed: number
  lifecycle_status: 'active' | 'pending_merge' | 'archived'
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  repo_task_id: string
  phase_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<RepoTask[]>([])
  const currentTask = ref<RepoTask | null>(null)
  const messages = ref<Message[]>([])
  const taskErrors = ref<Record<string, string>>({})
  const retrying = ref<Set<string>>(new Set())

  async function fetchErrorsForTasks(taskList: RepoTask[]) {
    const failedTasks = taskList.filter(t => t.phase_status === 'failed' || t.phase_status === 'cancelled')
    const results = await Promise.allSettled(
      failedTasks.map(async (t) => {
        const info = await rpc<{ error: string | null }>('task.getLastError', { repoTaskId: t.id })
        return { id: t.id, error: info?.error }
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.error)
        taskErrors.value[r.value.id] = r.value.error
    }
    for (const t of taskList) {
      if (t.phase_status !== 'failed' && t.phase_status !== 'cancelled')
        delete taskErrors.value[t.id]
    }
  }

  async function fetchByRepo(repoId: string) {
    tasks.value = await rpc<RepoTask[]>('task.listByRepo', { repoId })
    await fetchErrorsForTasks(tasks.value)
  }

  async function fetchByRequirement(requirementId: string) {
    tasks.value = await rpc<RepoTask[]>('task.listByRequirement', { requirementId })
    await fetchErrorsForTasks(tasks.value)
  }

  async function fetchTask(id: string) {
    currentTask.value = await rpc<RepoTask>('task.get', { id })
  }

  async function fetchMessages(taskId: string, phaseId: string) {
    messages.value = await rpc<Message[]>('message.list', { taskId, phaseId })
  }

  async function createTask(requirementId: string, repoId: string): Promise<RepoTask> {
    return await rpc<RepoTask>('task.create', { requirementId, repoId })
  }

  async function startWorkflow(repoTaskId: string): Promise<void> {
    await rpc('workflow.start', { repoTaskId })
  }

  async function retry(taskId: string) {
    retrying.value.add(taskId)
    delete taskErrors.value[taskId]
    try {
      await rpc('workflow.retry', { repoTaskId: taskId })
    }
    catch (err: unknown) {
      taskErrors.value[taskId] = err instanceof Error ? err.message : String(err)
      retrying.value.delete(taskId)
      throw err
    }
  }

  function finishRetry(taskId: string) {
    retrying.value.delete(taskId)
  }

  async function confirm(taskId: string) {
    await rpc('workflow.confirm', { repoTaskId: taskId })
    await fetchTask(taskId)
  }

  async function sendFeedback(taskId: string, feedback: string) {
    await rpc('workflow.feedback', { repoTaskId: taskId, feedback })
    await fetchTask(taskId)
  }

  async function cancel(taskId: string) {
    await rpc('workflow.cancel', { repoTaskId: taskId })
    await fetchTask(taskId)
  }

  async function checkDependencies(): Promise<{ ok: boolean, missing: string[] }> {
    return await rpc('workflow.checkDependencies')
  }

  async function renameBranch(taskId: string, newSlug: string): Promise<RepoTask> {
    const { task } = await rpc<{ task: RepoTask, changed: boolean }>('task.renameBranch', { taskId, newSlug })
    if (currentTask.value?.id === taskId) currentTask.value = task
    const idx = tasks.value.findIndex(t => t.id === taskId)
    if (idx !== -1) tasks.value[idx] = task
    return task
  }

  async function cleanupAfterMerge(taskId: string, force = false): Promise<void> {
    await rpc('task.cleanupAfterMerge', { taskId, force })
    if (currentTask.value?.id === taskId) await fetchTask(taskId)
    const t = tasks.value.find(x => x.id === taskId)
    if (t) t.lifecycle_status = 'archived'
  }

  return {
    tasks, currentTask, messages, taskErrors, retrying,
    fetchByRepo, fetchByRequirement, fetchTask, fetchMessages,
    fetchErrorsForTasks,
    createTask, startWorkflow,
    retry, finishRetry, confirm, sendFeedback, cancel,
    checkDependencies,
    renameBranch, cleanupAfterMerge,
  }
})
