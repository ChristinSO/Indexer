import type { SearchResult } from './api'

export type SearchMode = 'sorted' | 'definitive'
export const DEFAULT_CUTOFF = 70

// Keep displayed scores and the inclusive cutoff on the same 0.1% scale.
// These are cosine similarities, not calibrated probabilities.
export function matchPercent(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 10
}

export function searchHits(hits: SearchResult['hits'], mode: SearchMode, cutoff: number) {
  return hits.filter(hit => Number.isFinite(hit.score) && (mode === 'sorted' || matchPercent(hit.score) >= cutoff))
}
