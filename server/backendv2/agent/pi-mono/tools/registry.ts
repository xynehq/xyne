// Central registry of pi-mono tools available to backendv2 agents.
//
// Every tool the runner knows about is declared here exactly once. Each entry
// owns its UI metadata (label, description, category) so the agent-config UI
// can enumerate the catalog via a single source of truth, and a `build(ctx)`
// that adapts the tool's individual factory signature to a uniform context.
//
// Adding a new tool: append a descriptor here, write its `build*Tool` factory,
// done. The runner and the future /v2/agents/tools endpoint pick it up
// automatically.
//
// The registry has no side effects at import time — `build` is invoked
// per-turn so each instantiated tool still closes over the active user +
// optional agent scope.
//
// Future tools (e.g. `dispatchSubagent`, see M7) live here too. Tools that
// only make sense when other state is present (e.g. dispatchSubagent only
// when the agent has sub-agents) are still declared here but filtered by the
// runner before being passed to pi-mono.

import { defineTool } from "@mariozechner/pi-coding-agent"

import type { AgentScope } from "../../agent-scope"
import type { Log } from "../../log"
import { buildGetChunksTool } from "./vespa/getChunks"
import { buildMetadataSearchTool } from "./vespa/metadataSearch"
import { buildVespaSearchTool } from "./vespa/search"
import { buildSearchWithinDocTool } from "./vespa/searchWithinDoc"

// Context every tool builder receives. Fields that only apply to a subset of
// tools (e.g. `agentScope` for vespaSearch / metadataSearch) are optional —
// individual builders pick what they need.
export type ToolBuildCtx = {
  userEmail: string
  logger: Log
  agentScope?: AgentScope
}

// Coarse grouping for the UI tool picker. Add new categories as needed.
export type ToolCategory = "retrieval"

export type ToolDescriptor = {
  name: string
  label: string
  /** Short, human-readable summary for the agent-config UI tool picker. */
  description: string
  category: ToolCategory
  build: (ctx: ToolBuildCtx) => ReturnType<typeof defineTool>
}

export const TOOL_REGISTRY: ReadonlyArray<ToolDescriptor> = [
  {
    name: "vespaSearch",
    label: "SEBI semantic search",
    description:
      "Semantic search across the ingested SEBI corpus. Default first step " +
      "for any topic / keyword question — returns top-scoring chunks per " +
      "document with snippets.",
    category: "retrieval",
    build: (ctx) =>
      buildVespaSearchTool({
        userEmail: ctx.userEmail,
        logger: ctx.logger,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
      }),
  },
  {
    name: "metadataSearch",
    label: "SEBI metadata filter",
    description:
      "Structured metadata search by concrete identifier (PAN, document_id, " +
      "circular number, entity name) or date range. Preferred over semantic " +
      "search when the user names a specific ID or entity.",
    category: "retrieval",
    build: (ctx) =>
      buildMetadataSearchTool({
        logger: ctx.logger,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
      }),
  },
  {
    name: "getChunks",
    label: "SEBI chunk reader",
    description:
      "Read a contiguous chunk range from a specific document. Use to " +
      "expand context around a hit found by vespaSearch / metadataSearch.",
    category: "retrieval",
    build: (ctx) => buildGetChunksTool(ctx.logger),
  },
  {
    name: "searchWithinDoc",
    label: "SEBI within-document search",
    description:
      "Semantic search constrained to a single docId. Use to find other " +
      "relevant passages (definitions, exceptions, cross-references) inside " +
      "a document already located.",
    category: "retrieval",
    build: (ctx) => buildSearchWithinDocTool(ctx.userEmail, ctx.logger),
  },
]

const toolByName: ReadonlyMap<string, ToolDescriptor> = new Map(
  TOOL_REGISTRY.map((t) => [t.name, t]),
)

export const getToolDescriptor = (
  name: string,
): ToolDescriptor | undefined => toolByName.get(name)

// Build the actual tool instances for a turn.
//
// `names` is taken literally — the function never inserts tools the caller
// didn't ask for. An empty array means the LLM has zero tools. The
// "[] = all" wildcard the early implementation had was removed; callers
// (chat service, dispatch-subagent tool) now always pass the explicit
// name list from the agent / sub-agent row. New agents created via the
// API default to the full registry server-side so they don't start
// empty by accident.
//
// Order is preserved from `names`. Unknown names are silently dropped
// (validated at the API layer when an agent is saved).
export const buildToolsForRun = (
  names: ReadonlyArray<string>,
  ctx: ToolBuildCtx,
): ReturnType<typeof defineTool>[] => {
  const built: ReturnType<typeof defineTool>[] = []
  for (const n of names) {
    const d = toolByName.get(n)
    if (d) {
      built.push(d.build(ctx))
    }
  }
  return built
}

// Convenience for callers that genuinely want every tool in the registry
// (e.g. create-time defaulting in the agents service). Use sparingly — by
// design, run-time tool selection should come from the agent row, not the
// registry, so future tools added here don't silently start firing on
// existing agents.
export const allRegisteredToolNames = (): string[] =>
  TOOL_REGISTRY.map((t) => t.name)
