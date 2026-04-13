const STORAGE_KEY = 'consult-chat-states'
const MAX_MESSAGES_PER_REPO = 200

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface PerRepoChatState {
  messages: ChatMessage[]
  sessionId: string | null
}

type StatesMap = Record<string, PerRepoChatState>

function loadFromStorage(): StatesMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  }
  catch {
    return {}
  }
}

function saveToStorage(states: StatesMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
  }
  catch { /* quota exceeded — silently ignore */ }
}

const states: StatesMap = loadFromStorage()

function ensureState(repoId: string): PerRepoChatState {
  if (!states[repoId]) {
    states[repoId] = { messages: [], sessionId: null }
  }
  return states[repoId]
}

export function getMessages(repoId: string): ChatMessage[] {
  return ensureState(repoId).messages
}

export function getSessionId(repoId: string): string | null {
  return ensureState(repoId).sessionId
}

export function saveMessages(repoId: string, messages: ChatMessage[]): void {
  const state = ensureState(repoId)
  state.messages = messages.length > MAX_MESSAGES_PER_REPO
    ? messages.slice(-MAX_MESSAGES_PER_REPO)
    : messages
  saveToStorage(states)
}

export function saveSessionId(repoId: string, sessionId: string | null): void {
  ensureState(repoId).sessionId = sessionId
  saveToStorage(states)
}

export function clearChat(repoId: string): void {
  states[repoId] = { messages: [], sessionId: null }
  saveToStorage(states)
}
