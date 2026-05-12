import { z } from "zod"

// --- Provider token issuance (API key auth) ---

export const issueTokenSchema = z.object({
  external_user_id: z.string().min(1),
  email: z.string().email().optional(),
  tags: z.array(z.string()).default([]),
})

// --- Provider dashboard auth (email+password) ---

export const providerSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  workspace_name: z.string().min(1),
})

export const providerLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// --- Provider config management ---

export const updateProviderConfigSchema = z.object({
  allowed_origins: z.array(z.string()).optional(),
  token_expiry_seconds: z.number().min(300).max(86400).optional(),
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

export const visibilityEnum = z.enum(["public", "authenticated"])

export const providerIngestSchema = z.object({
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
