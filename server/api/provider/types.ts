import { z } from "zod"

export const issueTokenSchema = z.object({
  external_user_id: z.string().min(1),
  email: z.string().email().optional(),
  tags: z.array(z.string()).default([]),
})

export const providerSearchSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().min(1).max(50).default(10).optional(),
})

export const providerChatSchema = z.object({
  query: z.string().min(1),
  session_id: z.string().optional(),
})

export const providerExplainSchema = z.object({
  text: z.string().min(1),
})

export const providerIngestSchema = z.object({
  collection_id: z.string().min(1),
  documents: z.array(
    z.object({
      title: z.string(),
      content: z.string(),
      access_tags: z.array(z.string()).default([]),
      source_url: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
})
