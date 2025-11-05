import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import { Apps, GoogleApps } from "@xyne/vespa-ts"
import { getErrorMessage } from "@/utils"
import { searchGoogleApps } from "@/search/vespa"
import config from "@/config"
import { formatSearchToolResponse } from "../utils"
import type { Ctx, WithExcludedIds } from "../types"
import { baseToolParams, createQuerySchema } from "../schemas"

const contactsSearchToolSchema = z.object({
  query: createQuerySchema(GoogleApps.Contacts, true),
  ...baseToolParams,
})

export type ContactsSearchToolParams = z.infer<typeof contactsSearchToolSchema>

type ToolSchemaParameters = Tool<
  ContactsSearchToolParams,
  Ctx
>["schema"]["parameters"]
const toToolSchemaParameters = (schema: ZodType): ToolSchemaParameters =>
  schema as unknown as ToolSchemaParameters

export const searchGoogleContactsTool: Tool<ContactsSearchToolParams, Ctx> = {
  schema: {
    name: "searchGoogleContacts",
    description:
      "Find people and contact information from Google Contacts. Search by name, email or organization. Useful for contact lookup, networking, and communication planning.",
    parameters: toToolSchemaParameters(contactsSearchToolSchema),
  },
  async execute(
    params: ContactsSearchToolParams & { excludedIds?: string[] },
    context: Ctx,
  ) {
    const { email } = context

    try {
      if (!email) {
        const errorMsg = "Email is required for Google contacts search."
        return ToolResponse.error(
          ToolErrorCodes.MISSING_REQUIRED_FIELD,
          errorMsg,
          {
            toolName: "searchGoogleContacts",
          },
        )
      }

      const offset = params.offset || 0
      const limit = params.limit
        ? Math.min(params.limit, config.maxUserRequestCount) + (offset ?? 0)
        : undefined

      const searchResults = await searchGoogleApps({
        app: GoogleApps.Contacts,
        email: email,
        query: params.query,
        limit,
        sortBy: "desc",
        excludeDocIds: params.excludedIds || [],
        offset,
      })

      const response = await formatSearchToolResponse(searchResults, {
        query: params.query,
        app: GoogleApps.Contacts,
        offset: params.offset,
        limit: params.limit,
        searchType: "Contact",
      })

      return ToolResponse.success(response.result, {
        toolName: "searchGoogleContacts",
        contexts: response.contexts,
      })
    } catch (error) {
      const errMsg = getErrorMessage(error)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Google contacts search error: ${errMsg}`,
        { toolName: "searchGoogleContacts" },
      )
    }
  },
}
