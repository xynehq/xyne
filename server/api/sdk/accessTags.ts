/**
 * Expand a list of access tags to include wildcard ancestor scopes.
 * "dpip.members" → ["dpip.members", "dpip.*"]
 * "dpip.reports.quarterly" → ["dpip.reports.quarterly", "dpip.reports.*", "dpip.*"]
 * "public" → ["public"] (no dots, no expansion)
 */
export function expandAccessTags(tags: string[]): string[] {
  const expanded = new Set<string>()
  for (const tag of tags) {
    expanded.add(tag)
    const parts = tag.split(".")
    for (let i = parts.length - 1; i >= 1; i--) {
      expanded.add(parts.slice(0, i).join(".") + ".*")
    }
  }
  return [...expanded]
}
