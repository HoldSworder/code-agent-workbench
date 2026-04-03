import { defineStore } from 'pinia'
import { ref } from 'vue'
import { rpc } from '../composables/use-sidecar'

export interface RepoTask {
  id: string
  requirement_id: string
  repo_id: string
  branch_name: string
  change_id: string
  current_phase: string
  phase_status: string
  openspec_path: string
  worktree_path: string
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

  async function fetchByRepo(repoId: string) {
    tasks.value = await rpc<RepoTask[]>('task.listByRepo', { repoId })
  }

  async function fetchByRequirement(requirementId: string) {
    tasks.value = await rpc<RepoTask[]>('task.listByRequirement', { requirementId })
  }

  async function fetchTask(id: string) {
    currentTask.value = await rpc<RepoTask>('task.get', { id })
  }

  async function fetchMessages(taskId: string, phaseId: string) {
    messages.value = await rpc<Message[]>('message.list', { taskId, phaseId })
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

  return { tasks, currentTask, messages, fetchByRepo, fetchByRequirement, fetchTask, fetchMessages, confirm, sendFeedback, cancel }
})
