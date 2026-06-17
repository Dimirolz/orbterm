export interface StackStatus {
  pg: boolean
  redis: boolean
  hasura: boolean
}

export interface AgentInfo {
  n: number
  name: string
  state: string
  codex: boolean
  working: boolean
  stack: StackStatus
}

export interface DiffStatus {
  dirty: boolean
  version: string
}

export const stackUp = (s: StackStatus) => s.pg && s.redis && s.hasura
export const stackPartial = (s: StackStatus) => (s.pg || s.redis || s.hasura) && !stackUp(s)

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `${res.status}`)
  return body as T
}

export const api = {
  list: () => request<AgentInfo[]>('/api/agents'),
  create: () => request<{ n: number; name: string }>('/api/agents', { method: 'POST' }),
  remove: (n: number) => request<unknown>(`/api/agents/${n}`, { method: 'DELETE' }),
  start: (n: number) => request<unknown>(`/api/agents/${n}/start`, { method: 'POST' }),
  stop: (n: number) => request<unknown>(`/api/agents/${n}/stop`, { method: 'POST' }),
  stopCodex: (n: number) => request<unknown>(`/api/agents/${n}/codex/stop`, { method: 'POST' }),
  stackUp: (n: number) => request<unknown>(`/api/agents/${n}/stack/up`, { method: 'POST' }),
  diff: (n: number) => request<{ diff: string }>(`/api/agents/${n}/diff`),
  diffStatus: (n: number) => request<DiffStatus>(`/api/agents/${n}/diff/status`),
}
