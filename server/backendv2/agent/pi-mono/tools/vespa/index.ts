// Vespa-backed research tools — built per-turn so each tool closes over the
// active user + (optional) agent scope. When an agent scope is present, the
// scope's allowlist drives visibility; otherwise the tools fall back to the
// KB-only view of items the user themselves uploaded.

import { defineTool } from "@mariozechner/pi-coding-agent"

import type { Log } from "../../../log"
import type { AgentScope } from "../../../agent-scope"
import { buildVespaSearchTool } from "./search"
import { buildGetChunksTool } from "./getChunks"
import { buildMetadataSearchTool } from "./metadataSearch"
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
  buildMetadataSearchTool({ logger, ...(agentScope ? { agentScope } : {}) }),
  buildGetChunksTool(logger),
  buildSearchWithinDocTool(userEmail, logger),
]
