import { z } from "zod"

// --- SDK token issuance (API key auth) ---

export const issueTokenSchema = z.object({
  external_user_id: z.string().min(1),
  email: z.string().email().optional(),
  tags: z.array(z.string()).default([]),
})

// --- SDK dashboard auth (email+password) ---

export const sdkSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  workspace_name: z.string().min(1),
})

export const sdkLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// --- SDK config management ---

export const updateSdkConfigSchema = z.object({
  allowed_origins: z.array(z.string()).optional(),
  token_expiry_seconds: z.number().min(300).max(86400).optional(),
})

export const sdkSearchSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().min(1).max(50).default(10).optional(),
  collection: z.string().optional(),
})

export const sdkChatSchema = z.object({
  query: z.string().min(1),
  session_id: z.string().optional(),
  collection: z.string().optional(),
})

export const sdkExplainSchema = z.object({
  text: z.string().min(1),
  collection: z.string().optional(),
})

// --- SDK collection management ---

export const createSdkCollectionSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
})

export const visibilityEnum = z.enum(["public", "authenticated"])

export const sdkIngestSchema = z.object({
  collection_id: z.string().min(1),
  documents: z.array(
    z.object({
      doc_id: z.string().optional(),
      title: z.string(),
      content: z.string(),
      visibility: visibilityEnum.default("public"),
      access_tags: z.array(z.string()).default([]),
      source_url: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
})

export const sdkSyncSchema = z.object({
  collection: z.string().min(1),
  source: z.string().min(1),
  documents: z.array(
    z.object({
      doc_id: z.string().min(1),
      title: z.string(),
      content: z.string(),
      visibility: visibilityEnum.default("public"),
      access_tags: z.array(z.string()).default([]),
      source_url: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
})
