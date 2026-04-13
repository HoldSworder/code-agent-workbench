const MAX_BUFFER_SIZE = 2 * 1024 * 1024 // 2 MB per key

export class AgentOutputBuffer {
  private buffers = new Map<string, string>()

  static leaderKey(runId: string): string {
    return `run:${runId}:leader`
  }

  static workerKey(runId: string, assignmentId: string): string {
    return `run:${runId}:assignment:${assignmentId}`
  }

  append(key: string, text: string): void {
    const existing = this.buffers.get(key) ?? ''
    const newContent = existing + text
    this.buffers.set(
      key,
      newContent.length > MAX_BUFFER_SIZE
        ? newContent.slice(-MAX_BUFFER_SIZE)
        : newContent,
    )
  }

  get(key: string, offset = 0): { content: string, totalLength: number } {
    const buf = this.buffers.get(key) ?? ''
    return {
      content: offset < buf.length ? buf.slice(offset) : '',
      totalLength: buf.length,
    }
  }

  clear(key: string): void {
    this.buffers.delete(key)
  }

  clearByRunId(runId: string): void {
    const prefix = `run:${runId}:`
    for (const key of this.buffers.keys()) {
      if (key.startsWith(prefix)) this.buffers.delete(key)
    }
  }

  keys(): string[] {
    return [...this.buffers.keys()]
  }
}
