import type {
  VespaChatMessage,
  VespaEvent,
  VespaMail,
  VespaMailAttachment,
  VespaSearchResultsSchema,
} from "@/search/types"
import {
  chatMessageSchema,
  eventSchema,
  mailAttachmentSchema,
  userSchema,
  fileSchema,
  mailSchema,
} from "@/search/types"
import type { VespaFile, VespaSearchResults } from "@/search/types"
import type { VespaUser } from "@/search/types"
import { OpenAIError, type Citation } from "@/shared/types"
import { splitGroupedCitationsWithSpaces } from "@/utils"
import { getLogger } from "@/logger"
import { z } from "zod"
import { updateMessageByExternalId } from "@/db/chat"
import { db } from "@/db/client"
import { MessageRole, Subsystem } from "@/types"
import type { SelectMessage } from "@/db/schema"

const Logger = getLogger(Subsystem.Chat)

export const textToCitationIndex = /\[(\d+)\]/g

export const processMessage = (
  text: string,
  citationMap: Record<number, number>,
) => {
  if (!text) {
    return ""
  }

  text = splitGroupedCitationsWithSpaces(text)
  return text.replace(textToCitationIndex, (match, num) => {
    const index = citationMap[num]

    return typeof index === "number" ? `[${index + 1}]` : ""
  })
}

export const searchToCitation = (result: VespaSearchResults): Citation => {
  const fields = result.fields
  if (result.fields.sddocname === userSchema) {
    return {
      docId: (fields as VespaUser).docId,
      title: (fields as VespaUser).name,
      url: `https://contacts.google.com/${(fields as VespaUser).email}`,
      app: (fields as VespaUser).app,
      entity: (fields as VespaUser).entity,
    }
  } else if (result.fields.sddocname === fileSchema) {
    return {
      docId: (fields as VespaFile).docId,
      title: (fields as VespaFile).title,
      url: (fields as VespaFile).url || "",
      app: (fields as VespaFile).app,
      entity: (fields as VespaFile).entity,
    }
  } else if (result.fields.sddocname === mailSchema) {
    return {
      docId: (fields as VespaMail).docId,
      title: (fields as VespaMail).subject,
      url: `https://mail.google.com/mail/u/0/#inbox/${fields.docId}`,
      app: (fields as VespaMail).app,
      entity: (fields as VespaMail).entity,
    }
  } else if (result.fields.sddocname === eventSchema) {
    return {
      docId: (fields as VespaEvent).docId,
      title: (fields as VespaEvent).name || "No Title",
      url: (fields as VespaEvent).url,
      app: (fields as VespaEvent).app,
      entity: (fields as VespaEvent).entity,
    }
  } else if (result.fields.sddocname === mailAttachmentSchema) {
    return {
      docId: (fields as VespaMailAttachment).docId,
      title: (fields as VespaMailAttachment).filename || "No Filename",
      url: `https://mail.google.com/mail/u/0/#inbox/${(fields as VespaMailAttachment).mailId}?projector=1&messagePartId=0.${(fields as VespaMailAttachment).partId}&disp=safe&zw`,
      app: (fields as VespaMailAttachment).app,
      entity: (fields as VespaMailAttachment).entity,
    }
  } else if (result.fields.sddocname === chatMessageSchema) {
    return {
      docId: (fields as VespaChatMessage).docId,
      title: (fields as VespaChatMessage).text,
      url: `https://${(fields as VespaChatMessage).domain}.slack.com/archives/${(fields as VespaChatMessage).channelId}/p${(fields as VespaChatMessage).updatedAt}`,
      app: (fields as VespaChatMessage).app,
      entity: (fields as VespaChatMessage).entity,
    }
  } else {
    throw new Error("Invalid search result type for citation")
  }
}

const searchToCitations = (
  results: z.infer<typeof VespaSearchResultsSchema>[],
): Citation[] => {
  if (results.length === 0) {
    return []
  }
  return results.map((result) => searchToCitation(result as VespaSearchResults))
}

// the Set is passed by reference so that singular object will get updated
// but need to be kept in mind
export const checkAndYieldCitations = function* (
  text: string,
  yieldedCitations: Set<number>,
  results: any[],
  baseIndex: number = 0,
) {
  let match
  while ((match = textToCitationIndex.exec(text)) !== null) {
    const citationIndex = parseInt(match[1], 10)
    if (!yieldedCitations.has(citationIndex)) {
      const item = results[citationIndex - baseIndex]
      if (item) {
        yield {
          citation: {
            index: citationIndex,
            item: searchToCitation(item as VespaSearchResults),
          },
        }
        yieldedCitations.add(citationIndex)
      } else {
        Logger.error(
          "Found a citation index but could not find it in the search result ",
          citationIndex,
          results.length,
        )
      }
    }
  }
}

export const handleError = (error: any) => {
  let errorMessage = "Something went wrong. Please try again."
  if (error?.code === OpenAIError.RateLimitError) {
    errorMessage = "Rate limit exceeded. Please try again later."
  } else if (error?.code === OpenAIError.InvalidAPIKey) {
    errorMessage =
      "Invalid API key provided. Please check your API key and ensure it is correct."
  }
  return errorMessage
}

export const addErrMessageToMessage = async (
  lastMessage: SelectMessage,
  errorMessage: string,
) => {
  if (lastMessage.messageRole === MessageRole.User) {
    await updateMessageByExternalId(db, lastMessage?.externalId, {
      errorMessage,
    })
  }
}
