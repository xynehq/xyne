import type { ToolDefinition } from "@mariozechner/pi-coding-agent"

import { lsKnowledgeBaseTool } from "./ls-knowledge-base"
import { searchKnowledgeBaseTool } from "./search-knowledge-base"
import { toDoWriteTool } from "./to-do-write"
import { getDocumentOutlineTool } from "./get-document-outline"
import { getPageContentTool } from "./get-page-content"

export interface ConnectionStatus {}

export async function checkConnectionStatus(
  _email: string,
): Promise<ConnectionStatus> {
  return {}
}

export async function getAvailableTools(
  _email: string,
): Promise<ToolDefinition<any, any, any>[]> {
  return [
    toDoWriteTool,
    lsKnowledgeBaseTool,
    searchKnowledgeBaseTool,
    getDocumentOutlineTool,
    getPageContentTool,
  ]
}
