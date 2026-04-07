export type { AttachmentContext } from "./types"

// Document and thread processing
export {
  processAttachments,
  type ProcessAttachmentsOptions,
  type ProcessedAttachments,
} from "./documents"

// Image loading
export { getImagesForAgent } from "./images"
