// Vespa-backed research tools — built per-turn so each tool closes over the
// active user + (optional) agent scope. When an agent scope is present, the
// scope's allowlist drives visibility; otherwise the tools fall back to the
// KB-only view of items the user themselves uploaded.

import { defineTool } from "@mariozechner/pi-coding-agent"

import type { Log } from "../../../log"
import type { AgentScope } from "../../../agent-scope"
import { buildVespaSearchTool } from "./search"
import { buildGetChunksTool } from "./getChunks"
// NOTE: `./metadataSearch` is implemented but intentionally NOT imported/
// surfaced to the LLM yet. The file stays in the repo so the tool is one
// import + array-entry away when we're ready to ship.
import { buildSearchWithinDocTool } from "./searchWithinDoc"

export type VespaToolsArgs = {
  userEmail: string
  /** Turn-scoped parent logger; tools attach toolCallId+toolName at execute time. */
  logger: Log
  /** Optional custom agent scope. When set, vespa search switches to the
   *  agent-allowlist path; when omitted, search stays in KB-only mode. */
  agentScope?: AgentScope
}

export const buildVespaTools = ({
  userEmail,
  logger,
  agentScope,
}: VespaToolsArgs): ReturnType<typeof defineTool>[] => [
  buildVespaSearchTool({ userEmail, logger, agentScope }),
  // To re-enable metadataSearch: add the import for `buildMetadataSearchTool`
  // above and uncomment the call below. When re-enabling, also restore the
  // metadataSearch mention in the system prompt at runner.ts.
  // buildMetadataSearchTool({ logger, ...(agentScope ? { agentScope } : {}) }),
  buildGetChunksTool(logger),
  buildSearchWithinDocTool(userEmail, logger),
]
