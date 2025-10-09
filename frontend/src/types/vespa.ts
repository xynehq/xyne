import { z } from "zod"

// Copied from @xyne/vespa-ts for frontend use
export const VespaFileSchema = z.object({
  docId: z.string(),
  title: z.string(),
  url: z.string().optional(),
  mimeType: z.string(),
  size: z.number().optional(),
  modifiedTime: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // Add other fields as needed based on your usage
})

export type FileSchema = z.infer<typeof VespaFileSchema>
export type VespaFile = FileSchema // Alias for compatibility
