// Compose the final system prompt sent to the LLM from three independently-
// editable sections: main, tools, and sub-agents.
//
// Each section has a per-agent override (stored on the agents row from M4)
// and a default (see ./defaults/*). The assembler does not know about the
// DB — it takes plain strings + an optional list of sub-agents and returns
// the joined prompt. The chat service is responsible for resolving overrides
// vs defaults before calling.
//
// Order is fixed at main → tools → sub-agents. The sub-agents section is
// suppressed entirely when no sub-agents are provided (telling the LLM
// about dispatchSubagent it doesn't have would just confuse it).

import { DEFAULT_SYSTEM_PROMPT_MAIN } from "./defaults/main"
import { DEFAULT_SYSTEM_PROMPT_SUBAGENTS } from "./defaults/subagents"
import { DEFAULT_SYSTEM_PROMPT_TOOLS } from "./defaults/tools"

export type SystemPromptSections = {
  main?: string | null
  tools?: string | null
  subagents?: string | null
}

export type SubAgentSummary = {
  name: string
  description: string
}

// Resolve a section value: use the override when it is a non-empty string,
// otherwise fall back to the default. `null` and empty strings are treated
// as "no override" so the UI can clear a field back to the default by
// blanking the textarea.
const resolve = (
  override: string | null | undefined,
  fallback: string,
): string => {
  if (typeof override === "string" && override.trim().length > 0) {
    return override
  }
  return fallback
}

// Render the `<subagents>` catalog appended after the sub-agents instruction
// text. We use XML-ish tags because the rest of the prompt (citations, tool
// outputs) already speaks the same shape — keeps formatting consistent for
// the LLM.
const renderSubAgentCatalog = (subAgents: SubAgentSummary[]): string => {
  if (subAgents.length === 0) {
    return ""
  }
  const items = subAgents.map(
    (s) => `  <subagent name="${s.name}">${s.description}</subagent>`,
  )
  return ["<subagents>", ...items, "</subagents>"].join("\n")
}

export const assembleSystemPrompt = (
  sections: SystemPromptSections,
  subAgents: ReadonlyArray<SubAgentSummary> = [],
): string => {
  const main = resolve(sections.main, DEFAULT_SYSTEM_PROMPT_MAIN)
  const tools = resolve(sections.tools, DEFAULT_SYSTEM_PROMPT_TOOLS)

  // Sub-agents section: only render when there is at least one sub-agent.
  // The instruction text (about how to dispatch) is paired with the catalog
  // of available sub-agents — both come together or both stay out.
  let subAgentBlock = ""
  if (subAgents.length > 0) {
    const instructions = resolve(
      sections.subagents,
      DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
    )
    const catalog = renderSubAgentCatalog([...subAgents])
    subAgentBlock = [instructions, catalog].filter((s) => s.length > 0).join(
      "\n\n",
    )
  }

  return [main, tools, subAgentBlock].filter((s) => s.length > 0).join("\n\n")
}
