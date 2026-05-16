// SEBI research tools — built per-turn so the agent always has the right
// user email scoped into each tool via closure.

import { defineTool } from "@mariozechner/pi-coding-agent"

import type { Log } from "../../../log"
import { buildVespaSearchTool } from "./search"
import { buildGetChunksTool } from "./getChunks"
import { buildSearchWithinDocTool } from "./searchWithinDoc"

export type VespaToolsArgs = {
  userEmail: string
  /** Turn-scoped parent logger; tools attach toolCallId+toolName at execute time. */
  logger: Log
}

export const buildVespaTools = ({
  userEmail,
  logger,
}: VespaToolsArgs): ReturnType<typeof defineTool>[] => [
  buildVespaSearchTool(userEmail, logger),
  buildGetChunksTool(logger),
  buildSearchWithinDocTool(userEmail, logger),
]
