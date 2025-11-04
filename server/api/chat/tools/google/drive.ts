import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import { Apps, GoogleApps, DriveEntity } from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { searchGoogleApps } from "@/search/vespa"
import { formatSearchToolResponse, parseAgentAppIntegrations } from "../utils"
import { extractDriveIds } from "@/search/utils"
import config from "@/config"
import type { Ctx, WithExcludedIds } from "../types"
import { baseToolParams, createQuerySchema } from "../schemas"

const driveSearchToolSchema = z.object({
  query: createQuerySchema(GoogleApps.Drive),
  owner: z.string().describe("Filter files by owner").optional(),
  ...baseToolParams,
  filetype: z
    .array(z.nativeEnum(DriveEntity))
    .describe(
      `Filter files by type. Available types: ${Object.values(DriveEntity)
        .map((e) => `'${e}'`)
        .join(", ")}.`,
    )
    .optional(),
})

export type DriveSearchToolParams = z.infer<typeof driveSearchToolSchema>

type ToolSchemaParameters = Tool<
  DriveSearchToolParams,
  Ctx
>["schema"]["parameters"]
const toToolSchemaParameters = (schema: ZodType): ToolSchemaParameters =>
  schema as unknown as ToolSchemaParameters

export const searchDriveFilesTool: Tool<DriveSearchToolParams, Ctx> = {
  schema: {
    name: "searchDriveFiles",
    description:
      "Access and search files in Google Drive. Find documents, spreadsheets, presentations, PDFs, and folders by name, content, owner, or file type. Essential for document management and collaboration.",
    parameters: toToolSchemaParameters(driveSearchToolSchema),
  },
  async execute(
    params: DriveSearchToolParams & { excludedIds?: string[] },
    context: Ctx,
  ) {
    const { email, agentPrompt } = context

    try {
      if (!email) {
        const errorMsg = "Email is required for Drive files search."
        return ToolResponse.error(
          ToolErrorCodes.MISSING_REQUIRED_FIELD,
          errorMsg,
          {
            toolName: "searchDriveFiles",
          },
        )
      }

      const { agentAppEnums, selectedItems } =
        parseAgentAppIntegrations(agentPrompt)

      // Check if Google Drive is allowed for this agent
      if (agentAppEnums && agentAppEnums.length > 0) {
        if (!agentAppEnums.includes(Apps.GoogleDrive)) {
          const errorMsg =
            "Google Drive is not allowed for this agent. Cannot search."
          return ToolResponse.error(
            ToolErrorCodes.PERMISSION_DENIED,
            errorMsg,
            {
              toolName: "searchDriveFiles",
            },
          )
        }
      }

      let driveSourceIds: string[] = []
      if (selectedItems) {
        driveSourceIds = await extractDriveIds(
          { selectedItem: selectedItems },
          email!,
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
        app: GoogleApps.Drive,
        email: email,
        query: params.query,
        limit,
        offset,
        sortBy: params.sortBy || "desc",
        timeRange: timeRange,
        owner: params.owner,
        driveEntity: params.filetype,
        excludeDocIds: params.excludedIds || [],
        docIds: driveSourceIds,
      })

      const response = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Drive,
        timeRange: timeRange,
        offset: params.offset,
        limit: params.limit,
        searchType: "Drive file",
      })

      return ToolResponse.success(response.result, {
        toolName: "searchDriveFiles",
        contexts: response.contexts,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Drive files search error: ${errMsg}`,
        { toolName: "searchDriveFiles" },
      )
    }
  },
}
