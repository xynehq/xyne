import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import { Apps, GoogleApps } from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { searchGoogleApps } from "@/search/vespa"
import config from "@/config"
import { formatSearchToolResponse, parseAgentAppIntegrations } from "../utils"
import type { Ctx, WithExcludedIds } from "../types"
import type { EventStatusType } from "@xyne/vespa-ts"
import { baseToolParams, createQuerySchema } from "../schemas"

const calendarSearchToolSchema = z.object({
  query: createQuerySchema(GoogleApps.Calendar, true),
  attendees: z
    .array(z.string())
    .describe("Filter events by attendee  name or email addresses")
    .optional(),
  status: z
    .enum(["confirmed", "tentative", "cancelled"])
    .describe(
      "Filter events by status. Available statuses: 'confirmed', 'tentative', 'cancelled'",
    )
    .optional(),
  ...baseToolParams,
})

export type CalendarSearchToolParams = z.infer<typeof calendarSearchToolSchema>

type ToolSchemaParameters = Tool<
  CalendarSearchToolParams,
  Ctx
>["schema"]["parameters"]
const toToolSchemaParameters = (schema: ZodType): ToolSchemaParameters =>
  schema as unknown as ToolSchemaParameters

export const searchCalendarEventsTool: Tool<CalendarSearchToolParams, Ctx> = {
  schema: {
    name: "searchCalendarEvents",
    description:
      "Retrieve calendar events and meetings from Google Calendar. Search by event title, attendees, or time period. Ideal for scheduling analysis, meeting preparation, and availability checking.",
    parameters: toToolSchemaParameters(calendarSearchToolSchema),
  },
  async execute(
    params: WithExcludedIds<CalendarSearchToolParams>,
    context: Ctx,
  ) {
    const { email, agentPrompt } = context

    try {
      if (!email) {
        const errorMsg = "Email is required for calendar events search."
        return ToolResponse.error(
          ToolErrorCodes.MISSING_REQUIRED_FIELD,
          errorMsg,
          {
            toolName: "searchCalendarEvents",
          },
        )
      }

      const { agentAppEnums } = parseAgentAppIntegrations(agentPrompt)

      // Check if Google Calendar is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.GoogleCalendar)) {
          const errorMsg =
            "Google Calendar is not allowed for this agent. Cannot search."
          return ToolResponse.error(
            ToolErrorCodes.PERMISSION_DENIED,
            errorMsg,
            {
              toolName: "searchCalendarEvents",
            },
          )
        }
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
        app: GoogleApps.Calendar,
        email: email,
        query: params.query,
        limit,
        offset,
        sortBy: params.sortBy || "desc",
        timeRange: timeRange,
        attendees: params.attendees,
        eventStatus: params.status as EventStatusType,
        excludeDocIds: params.excludedIds || [],
        docIds: undefined,
      })

      const response = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Calendar,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Calendar event",
      })

      return ToolResponse.success(response.result, {
        toolName: "searchCalendarEvents",
        contexts: response.contexts,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Calendar events search error: ${errMsg}`,
        { toolName: "searchCalendarEvents" },
      )
    }
  },
}
