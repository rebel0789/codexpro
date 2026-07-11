import type { WorkspaceAnalysis } from "./types.js";

const MAX_CACHE_ENTRIES = 8;
const cache = new Map<string, WorkspaceAnalysis>();

export function getCachedWorkspaceAnalysis(key: string): WorkspaceAnalysis | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function setCachedWorkspaceAnalysis(key: string, value: WorkspaceAnalysis): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function invalidateWorkspaceAnalysis(workspaceId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
  }
}
