/**
 * Fragment deduplication helpers for pi-mono tools and extension.
 *
 * Shared so that both tool-level pushes and extension-level ranking
 * use the same dedup key logic, avoiding duplicates in allFragments.
 */

import type { MinimalAgentFragment } from "@/api/chat/types"

/**
 * Derive a dedup key for a fragment.
 * Prefers vespaDocId (chunk-level) over the generic fragment id.
 */
export function getFragmentDedupKey(fragment: MinimalAgentFragment): string {
  if (!fragment?.id) return ""
  const vespaDocId = fragment.source?.docId
  if (vespaDocId != null && vespaDocId !== "") return vespaDocId
  return fragment.id
}

/**
 * Merge `incoming` fragments into `target`, deduplicating by dedup key.
 * If a duplicate is found the incoming copy *replaces* the existing one
 * (in case it carries fresher metadata).  Returns a new array.
 */
export function mergeFragmentLists(
  target: MinimalAgentFragment[],
  incoming: MinimalAgentFragment[],
): MinimalAgentFragment[] {
  if (!incoming.length) return target
  const merged = [...target]
  const indexByDedupKey = new Map<string, number>()
  merged.forEach((fragment, idx) => {
    const key = getFragmentDedupKey(fragment)
    if (key) indexByDedupKey.set(key, idx)
  })
  for (const fragment of incoming) {
    const key = getFragmentDedupKey(fragment)
    if (!key) continue
    const existingIndex = indexByDedupKey.get(key)
    if (existingIndex !== undefined) {
      merged[existingIndex] = fragment
    } else {
      indexByDedupKey.set(key, merged.length)
      merged.push(fragment)
    }
  }
  return merged
}
