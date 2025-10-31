import { z } from "zod"
import config from "@/config"
import { retrievalQueryDescription } from "@/api/chat/mapper"
import type { GoogleApps } from "@xyne/vespa-ts"

// Common pagination schemas
export const limitSchema = z
  .number()
  .min(1)
  .max(100)
  .describe(
    "Maximum number of results to return. Default behavior is to return 20 results.",
  )
  .default(20)

export const offsetSchema = z
  .number()
  .min(0)
  .describe(
    "Number of results to skip from the beginning, useful for pagination.",
  )
  .optional()

export const sortBySchema = z
  .enum(["asc", "desc"])
  .describe("Sort order of results. Accepts 'asc' or 'desc'.")
  .optional()

// Common time range schema
export const timeRangeSchema = z
  .object({
    startTime: z
      .string()
      .describe(`Start time in ${config.llmTimeFormat} format`),
    endTime: z.string().describe(`End time in ${config.llmTimeFormat} format`),
  })
  .describe("Time range filter")

export const createQuerySchema = (app?: GoogleApps, required = false) => {
  const baseSchema = z.string().describe(retrievalQueryDescription(app))
  return required
    ? baseSchema.min(1, `Query is required for ${app} search`)
    : baseSchema.optional()
}

// Common base parameters
export const baseToolParams = {
  limit: limitSchema,
  offset: offsetSchema,
  sortBy: sortBySchema,
}

// Time range with description factory
export const createTimeRangeSchema = (description?: string) =>
  timeRangeSchema
    .describe(
      description ||
        `Filter within a specific time range. Example: { startTime: ${config.llmTimeFormat}, endTime: ${config.llmTimeFormat} }`,
    )
    .optional()
