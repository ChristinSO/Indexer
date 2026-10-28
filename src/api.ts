let token = ''
export async function connect() {
  const response = await fetch('/api/session')
  if (!response.ok) throw new Error('Cannot connect to Indexer Alpha. Check that the local service is running.')
  token = (await response.json()).token
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!token) await connect()
  const headers: Record<string, string> = { 'x-indexer-token': token }
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(`/api${path}`, { ...options, headers: { ...headers, ...options.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status}). Please try again.`)
  }
  return response.json()
}

export interface Photo { id: string; name: string; width: number; height: number; size: number; created: string; status: 'queued' | 'indexing' | 'ready' | 'failed'; error: string | null; favorite: number }
export interface Status { model: string; model_error: string | null; device: string | null; mode: string; dtype: string | null; paused: boolean; total: number; ready: number; failed: number; active: string | null; download_bytes: number; model_bytes: number; metrics: { api_rss: number; rss?: number; gpu_allocated?: number; gpu_reserved?: number; milliseconds?: number } }
export type SearchScope = 'photos' | 'favorites'
export interface SearchResult { hits: { id: string; score: number }[]; milliseconds: number; searched: number; scope: SearchScope }
