// Public surface for the system-prompt module.
//
// Callers should import `assembleSystemPrompt` for runtime composition and
// the `DEFAULT_SYSTEM_PROMPT_*` constants when they need to display the
// canonical defaults (e.g. the agent-form's "Use default" button). The
// older `DEFAULT_SYSTEM_PROMPT` symbol is kept as a back-compat re-export
// — it returns the same text the assembler would produce with no overrides
// and no sub-agents.

import { DEFAULT_SYSTEM_PROMPT_MAIN } from "./defaults/main"
import { DEFAULT_SYSTEM_PROMPT_SUBAGENTS } from "./defaults/subagents"
import { DEFAULT_SYSTEM_PROMPT_TOOLS } from "./defaults/tools"
import { assembleSystemPrompt } from "./assemble"

export {
  DEFAULT_SYSTEM_PROMPT_MAIN,
  DEFAULT_SYSTEM_PROMPT_TOOLS,
  DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
}
export {
  assembleSystemPrompt,
  type SystemPromptSections,
  type SubAgentSummary,
} from "./assemble"

// Back-compat: the single-string default that callers (chat service,
// /v2/agents/defaults handler, runner) imported before the three-section
// refactor. Equivalent to assembling with no overrides and no sub-agents.
export const DEFAULT_SYSTEM_PROMPT = assembleSystemPrompt({})

// Inputs to resolve the system prompt for a given agent. Mirrors the
// AgentScope shape but with only the fields that matter to prompt
// resolution — agent-scope.ts builds this projection.
export type AgentPromptInputs = {
  systemPromptMain?: string | null
  systemPromptTools?: string | null
  systemPromptSubagents?: string | null
  subAgents?: ReadonlyArray<SubAgentSummary>
}

// Decide which prompt to send to the LLM for a given agent.
//
// After the legacy `prompt` column was migrated into `system_prompt_main`
// (see server/scripts/migrate-prompt-to-main.sql), the resolver has a
// single path: assemble main + tools + sub-agents catalog from whatever
// per-section overrides the row carries, with the workspace defaults
// filling any null/empty slot. No legacy fallback, no special cases.
export const resolveAgentSystemPrompt = (inputs: AgentPromptInputs): string =>
  assembleSystemPrompt(
    {
      main: inputs.systemPromptMain ?? null,
      tools: inputs.systemPromptTools ?? null,
      subagents: inputs.systemPromptSubagents ?? null,
    },
    inputs.subAgents ?? [],
  )

// Late import to keep the type circular-ref clean (SubAgentSummary is
// re-exported above from ./assemble).
import type { SubAgentSummary } from "./assemble"
