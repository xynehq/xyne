import { createDefaultRegistry } from "./handlers"

export { ToolHandlerRegistry } from "./registry"

export type {
  ToolCallContext,
  ToolHandler,
  SearchKBDetails,
  ToDoWriteDetails,
} from "./types"

export const toolEventRegistry = createDefaultRegistry()
