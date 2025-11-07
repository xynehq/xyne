import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import { Apps, GoogleApps } from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { expandEmailThreadsInResults } from "@/api/chat/utils"
import { searchGoogleApps } from "@/search/vespa"
import config from "@/config"
import { formatSearchToolResponse, parseAgentAppIntegrations } from "../utils"
import type { Ctx, WithExcludedIds } from "../types"
import { baseToolParams, createQuerySchema } from "../schemas"

export const participantsSchema = z
  .object({
    from: z.array(z.string().describe("From email addresses")).optional(),
    to: z.array(z.string().describe("To email addresses")).optional(),
    cc: z.array(z.string().describe("CC email addresses")).optional(),
    bcc: z.array(z.string().describe("BCC email addresses")).optional(),
  })
  .describe("Email participants filter")

const gmailSearchToolSchema = z.object({
  query: createQuerySchema(GoogleApps.Gmail),
  ...baseToolParams,
  labels: z
    .array(z.string().describe("Gmail label"))
    .describe(
      "Filter emails by Gmail labels. labels are 'IMPORTANT', 'STARRED', 'UNREAD', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'DRAFT', 'SENT', 'INBOX', 'SPAM', 'TRASH'.",
    )
    .optional(),
  participants: participantsSchema
    .describe(
      `Advanced email communication filtering with intelligent resolution of names, organizations, and email addresses. Supports complex multi-participant email queries with automatic name-to-email mapping. - Structure: {from?: string[], to?: string[], cc?: string[], bcc?: string[]}. - Each field accepts arrays containing email addresses, full names, first names, or organization names.`,
    )
    .optional(),
})

export type GmailSearchToolParams = z.infer<typeof gmailSearchToolSchema>

type ToolSchemaParameters = Tool<
  GmailSearchToolParams,
  Ctx
>["schema"]["parameters"]
const toToolSchemaParameters = (schema: ZodType): ToolSchemaParameters =>
  schema as unknown as ToolSchemaParameters

export const searchGmailTool: Tool<GmailSearchToolParams, Ctx> = {
  schema: {
    name: "searchGmail",
    description:
      "Find and retrieve emails. Can search by keywords, filter by sender/recipient, time period, labels, or simply fetch recent emails when no query is provided.",
    parameters: toToolSchemaParameters(gmailSearchToolSchema),
  },
  async execute(params: WithExcludedIds<GmailSearchToolParams>, context: Ctx) {
    const { email, agentPrompt } = context

    try {
      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      // Check if Gmail is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.Gmail)) {
          const errorMsg = "Gmail is not allowed for this agent. Cannot search."
          return ToolResponse.error(
            ToolErrorCodes.PERMISSION_DENIED,
            errorMsg,
            {
              toolName: "searchGmail",
            },
          )
        }
      }

      if (!email) {
        const errorMsg = "Email is required for Gmail search."
        return ToolResponse.error(
          ToolErrorCodes.MISSING_REQUIRED_FIELD,
          errorMsg,
          {
            toolName: "searchGmail",
          },
        )
      }

      let timeRange: { startTime: number; endTime: number } | undefined
      if (params.timeRange) {
        timeRange = {
          startTime: params.timeRange.startTime
            ? new Date(params.timeRange.startTime).getTime()
            : 0,
          endTime: params.timeRange.endTime
            ? new Date(params.timeRange.endTime).getTime()
            : Date.now(),
        }
      }

      const offset = params.offset || 0
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + (offset ?? 0)
        : undefined

      const searchResults = await searchGoogleApps({
        app: GoogleApps.Gmail,
        email: email,
        query: params.query,
        limit,
        offset,
        sortBy: params.sortBy || "desc",
        labels: params.labels,
        timeRange: timeRange,
        participants: params.participants || {},
        excludeDocIds: params.excludedIds || [],
        docIds: undefined,
      })

      if (
        searchResults?.root?.children &&
        searchResults.root.children.length > 0
      ) {
        searchResults.root.children = await expandEmailThreadsInResults(
          searchResults.root.children,
          email,
        )
      }

      const response = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Gmail,
        labels: params.labels,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Gmail message",
      })

      return ToolResponse.success(response.result, {
        toolName: "searchGmail",
        contexts: response.contexts,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Gmail search error: ${errMsg}`,
        { toolName: "searchGmail" },
      )
    }
  },
}
