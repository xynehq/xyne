import type { MinimalAgentFragment } from "@/api/chat/types"
import config from "@/config"

export function formatFragmentsForLLM(
  fragments: MinimalAgentFragment[],
  startIndex: number,
  maxFragments: number = config.maxDefaultSummary,
): string {
  if (fragments.length === 0) return "No results found."

  return fragments
    .slice(0, maxFragments)
    .map((fragment, index) => {
      const citationIndex = startIndex + index
      return `citationDocId: ${citationIndex}\n${fragment.content}`
    })
    .join("\n\n")
}
