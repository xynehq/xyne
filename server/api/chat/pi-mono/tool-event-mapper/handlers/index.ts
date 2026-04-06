import { ToolHandlerRegistry } from "../registry"
import { lsKnowledgeBaseHandler } from "./ls-knowledge-base"
import { searchKBHandler } from "./search-kb"
import { todoWriteHandler } from "./todo-write"

export function createDefaultRegistry(): ToolHandlerRegistry {
  return new ToolHandlerRegistry().registerAll(
    searchKBHandler,
    todoWriteHandler,
    lsKnowledgeBaseHandler,
  )
}
