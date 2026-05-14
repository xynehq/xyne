import type { MinimalAgentFragment } from "@/api/chat/types"

export interface AttachmentContext {
  fragments: MinimalAgentFragment[]
  summary: string
}
