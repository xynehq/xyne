import {
  answerContextMap,
  answerMetadataContextMap,
  cleanContext,
  userContext,
} from "@/ai/context"
import { parse, Allow, STR, ARR, OBJ } from "partial-json"
import {
  analyzeInitialResultsOrRewrite,
  analyzeInitialResultsOrRewriteV2,
  analyzeQueryForNamesAndEmails,
  analyzeQueryMetadata,
  answerOrSearch,
  askQuestionWithCitations,
  generateTitleUsingQuery,
  jsonParseLLMOutput,
  listItems,
  Models,
  QueryCategory,
  QueryType,
  routeQuery,
  SearchAnswerResponse,
  userChat,
  type ConverseResponse,
  type ListItemRouterResponse,
  type QueryRouterResponse,
  type ResultsOrRewrite,
} from "@/ai/provider/bedrock"
import config from "@/config"
import {
  getChatByExternalId,
  getPublicChats,
  insertChat,
  updateChatByExternalId,
} from "@/db/chat"
import { db } from "@/db/client"
import {
  getChatMessages,
  insertMessage,
  getMessageByExternalId,
  getChatMessagesBefore,
  updateMessage,
} from "@/db/message"
import {
  selectPublicChatSchema,
  selectPublicMessageSchema,
  selectPublicMessagesSchema,
  type InternalUserWorkspace,
  type PublicUserWorkspace,
  type SelectChat,
  type SelectMessage,
} from "@/db/schema"
import {
  getPublicUserAndWorkspaceByEmail,
  getUserAndWorkspaceByEmail,
} from "@/db/user"
import { getLogger } from "@/logger"
import { ChatSSEvents, type MessageReqType } from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { ConversationRole, Message } from "@aws-sdk/client-bedrock-runtime"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import type { chatSchema } from "@/api/search"
import {
  AddChatMessageIdToAttachment,
  getItems,
  insert,
  insertDocument,
  searchUsersByNamesAndEmails,
  searchVespa,
  searchVespaWithChatAttachment,
} from "@/search/vespa"
import {
  Apps,
  chatAttachmentSchema,
  DriveEntity,
  entitySchema,
  eventSchema,
  fileSchema,
  GooglePeopleEntity,
  MailEntity,
  mailSchema,
  userSchema,
  type VespaChatAttachment,
  type VespaFile,
  type VespaMail,
  type VespaSearchResponse,
  type VespaSearchResults,
  type VespaSearchResultsSchema,
  type VespaUser,
} from "@/search/types"
import llama3Tokenizer from "llama3-tokenizer-js"
import { encode } from "gpt-tokenizer"
import { getConnInfo } from "hono/bun"
import { APIError } from "openai"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import type { Document } from "@langchain/core/documents"
import { chunkDocument } from "@/chunks"
import { deleteDocument, downloadDir } from "@/integrations/google"
import fs from "node:fs"
import path from "node:path"

const { JwtPayloadKey, maxTokenBeforeMetadataCleanup } = config
const Logger = getLogger(Subsystem.Chat)

// this is not always the case but unless our router detects that we need
// these we will by default remove them
const nonWorkMailLabels = ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"]

enum RagPipelineStages {
  QueryRouter = "QueryRouter",
  NewChatTitle = "NewChatTitle",
  AnswerOrSearch = "AnswerOrSearch",
  AnswerWithList = "AnswerWithList",
  AnswerOrRewrite = "AnswerOrRewrite",
  RewriteAndAnswer = "RewriteAndAnswer",
  UserChat = "UserChat",
  DefaultRetrieval = "DefaultRetrieval",
}

const defaultFastModel = Models.Claude_3_5_Haiku
const defaultBestModel = Models.Claude_3_5_SonnetV2

// const ragPipeline = [
//   { stage: RagPipelineStages.NewChatTitle, modelId: defaultFastModel},
//   { stage: RagPipelineStages.AnswerOrRewrite, modelId: defaultBestModel},
//   { stage: RagPipelineStages.RewriteAndAnswer, modelId: defaultBestModel },
// ]

const ragPipelineConfig = {
  [RagPipelineStages.QueryRouter]: {
    modelId: defaultFastModel,
  },
  [RagPipelineStages.AnswerOrSearch]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.AnswerWithList]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.NewChatTitle]: {
    modelId: defaultFastModel,
  },
  [RagPipelineStages.AnswerOrRewrite]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.RewriteAndAnswer]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.UserChat]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.DefaultRetrieval]: {
    modelId: defaultBestModel,
    page: 5,
  },
}

export const GetChatApi = async (c: Context) => {
  try {
    // @ts-ignore
    const body: z.infer<typeof chatSchema> = c.req.valid("json")
    const { chatId } = body
    const [chat, messages] = await Promise.all([
      getChatByExternalId(db, chatId),
      getChatMessages(db, chatId),
    ])
    return c.json({
      chat: selectPublicChatSchema.parse(chat),
      messages: selectPublicMessagesSchema.parse(messages),
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      `Get Chat and Messages Error: ${errMsg} ${(error as Error).stack}`,
    )
    throw new HTTPException(500, {
      message: "Could not fetch chat and messages",
    })
  }
}

const blobToBuffer = async (blob: Blob) => {
  const arrayBuffer = await blob.arrayBuffer() // Convert Blob to ArrayBuffer
  return Buffer.from(arrayBuffer) // Convert ArrayBuffer to Buffer
}

const saveToDownloads = async (file: Blob) => {
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true })
  }

  // Define the file path
  const filePath = path.join(downloadDir, file?.name)

  // Convert the Blob to a Buffer
  const fileBuffer = await blobToBuffer(file)

  // Save the file
  try {
    await fs.promises.writeFile(filePath, fileBuffer)
    Logger.info(`File saved successfully to ${filePath}`)
  } catch (err) {
    console.error("Error saving file:", err)
    await deleteDocument(filePath)
  }
}

const getUploadFileDocId = (
  userEmail: string,
  fileName: string,
  dateTime: number,
) => {
  return `file_upload_${userEmail}_${fileName}_${dateTime}`
}

const handlePDFFile = async (file: Blob, userEmail: string) => {
  let wasDownloaded = false
  try {
    // saving the uploaded file in downloads folder
    await saveToDownloads(file)
    wasDownloaded = true

    let docs: Document[] = []
    const filePath = `${downloadDir}/${file?.name}`
    const loader = new PDFLoader(filePath)
    docs = await loader.load()

    if (!docs || docs.length === 0) {
      Logger.error(`Could not get content for file: ${file.name}. Skipping it`)
      await deleteDocument(filePath)
      return
    }

    const chunks = docs.flatMap((doc) => chunkDocument(doc.pageContent))

    const dateTime = new Date().getTime()

    const docId = getUploadFileDocId(userEmail, file?.name, dateTime)
    const pdfName = `${userEmail}_${file?.name}_${dateTime}`

    const pdfToIngest = {
      docId: docId,
      title: pdfName,
      ownerEmail: userEmail,
      chunks: chunks.map((v) => v.chunk),
      mimeType: "application/pdf",
      createdAt: dateTime,
      updatedAt: dateTime,
    }

    // @ts-ignore
    await insert(pdfToIngest, chatAttachmentSchema)

    // Delete the file here
    await deleteDocument(filePath)

    // Return metadata
    // Metadata contains docId, fileName, fileType, fileSize
    return {
      docId: docId,
      fileName: file?.name,
      fileSize: file?.size,
      fileType: file?.type,
    }
  } catch (err) {
    if (wasDownloaded) {
      const filePath = `${downloadDir}/${file?.name}`
      await deleteDocument(filePath)
    }
    Logger.error(
      `Error handling PDF ${file.name}: ${err} ${(err as Error).stack}`,
      err,
    )
  }
}

export const UploadFilesApi = async (c: Context) => {
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub

    const formData = await c.req.formData()
    const files = formData.getAll("files") as File[]
    const metadata: AttachmentMetadata[] = []

    for (const file of files) {
      // Parse file according to its type
      if (file.type === "application/pdf") {
        const fileMetadata = await handlePDFFile(file, email)

        if (fileMetadata?.docId && fileMetadata?.fileName) {
          metadata.push(fileMetadata)
        }

        Logger.info(`Upload file completed`)
      } else {
        Logger.error(`File type not supported yet`)
      }
    }

    return c.json({ attachmentsMetadata: metadata })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Error uploading files: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not upload files",
    })
  }
}

export const ChatRenameApi = async (c: Context) => {
  try {
    // @ts-ignore
    const { title, chatId } = c.req.valid("json")
    await updateChatByExternalId(db, chatId, { title })
    return c.json({ success: true })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Chat Rename Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not rename chat",
    })
  }
}

export const ChatHistory = async (c: Context) => {
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const { page } = c.req.valid("query")
    const pageSize = 20
    const offset = page * pageSize
    return c.json(await getPublicChats(db, email, pageSize, offset))
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Chat History Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not get chat history",
    })
  }
}

export const ChatBookmarkApi = async (c: Context) => {
  try {
    // @ts-ignore
    const body = c.req.valid("json")
    const { chatId, bookmark } = body
    await updateChatByExternalId(db, chatId, { isBookmarked: bookmark })
    return c.json({})
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Chat Bookmark Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not bookmark chat",
    })
  }
}

const MinimalCitationSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  app: z.nativeEnum(Apps).optional(),
  entity: entitySchema.optional(),
  mimeType: z.string().optional(),
  sddocname: z.string().optional(),
})

export type Citation = z.infer<typeof MinimalCitationSchema>

const AttachmentMetadataSchema = z.object({
  docId: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  fileType: z.string(),
})

export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>

interface CitationResponse {
  answer?: string
  citations?: number[]
}

const searchToCitation = (
  results: z.infer<typeof VespaSearchResultsSchema>[],
): Citation[] => {
  let citations: Citation[] = []

  if (!results || results?.length === 0) {
    return []
  }

  for (const result of results) {
    const fields = result.fields
    if (result.fields.sddocname === userSchema) {
      citations.push({
        title: (fields as VespaUser).name,
        url: `https://contacts.google.com/${(fields as VespaUser).email}`,
        app: (fields as VespaUser).app,
        entity: (fields as VespaUser).entity,
      })
    } else if (result.fields.sddocname === fileSchema) {
      citations.push({
        title: (fields as VespaFile).title,
        url: (fields as VespaFile).url || "",
        app: (fields as VespaFile).app,
        entity: (fields as VespaFile).entity,
      })
    } else if (result.fields.sddocname === mailSchema) {
      citations.push({
        title: (fields as VespaMail).subject,
        url: `https://mail.google.com/mail/u/0/#inbox/${fields.docId}`,
        app: (fields as VespaMail).app,
        entity: (fields as VespaMail).entity,
      })
    } else if (result.fields.sddocname === chatAttachmentSchema) {
      citations.push({
        title: (fields as VespaChatAttachment).title,
        sddocname: fields.sddocname,
        mimeType: (fields as VespaChatAttachment).mimeType || "",
      })
    } else {
      throw new Error("Invalid search result type for citation")
    }
  }
  return citations
}

const processMessage = (text: string, citationMap: Record<number, number>) => {
  return text.replace(/\[(\d+)\]/g, (match, num) => {
    return `[${citationMap[num] + 1}]`
  })
}

const chunkToParsed = async <T>(
  iterator: AsyncIterableIterator<ConverseResponse>,
): Promise<{ parsed: T; costArr: number[] }> => {
  let buffer = ""
  let parsed: T = {} as T
  const costArr: number[] = []

  for await (const chunk of iterator) {
    try {
      if (chunk.text) {
        buffer += chunk.text
        if (!buffer.trim()) {
          continue
        }
        parsed = jsonParseLLMOutput(buffer) as T
      }
      if (chunk.cost) {
        costArr.push(chunk.cost)
      }
    } catch (e) {
      continue
    }
  }
  return { parsed, costArr }
}

async function* getListData(
  email: string,
  query: string,
  userCtx: string,
  result: ListItemRouterResponse,
  messages?: Message[],
): AsyncIterableIterator<any> {
  let schema = ""
  if (result.filters.app === Apps.GoogleCalendar) {
    schema = eventSchema
  } else if (result.filters.app === Apps.GoogleDrive) {
    if (
      result.filters.entity === GooglePeopleEntity.AdminDirectory ||
      result.filters.entity === GooglePeopleEntity.Contacts ||
      result.filters.entity === GooglePeopleEntity.OtherContacts
    ) {
      schema = userSchema
    } else {
      schema = fileSchema
    }
  } else if (result.filters.app === Apps.Gmail) {
    schema = mailSchema
  } else if (result.filters.app === Apps.GoogleWorkspace) {
    schema = userSchema
  }
  if (schema) {
    let timestampRange: { from: number | null; to: number | null } = {
      from: null,
      to: null,
    }
    if (result.filters.startTime) {
      timestampRange.from = new Date(result.filters.startTime).getTime()
    }
    if (result.filters.endTime) {
      timestampRange.to = new Date(result.filters.endTime).getTime()
    }
    const vespaResults = await getItems({
      schema,
      app: result.filters.app,
      entity: result.filters.entity,
      timestampRange,
      limit: result.filters.count,
      offset: 0,
      email,
    })
    if (vespaResults.root.children) {
      const listContext = vespaResults.root.children
        .map((v, i) =>
          cleanContext(
            `Index ${i} \n ${answerMetadataContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
          ),
        )
        .join("\n\n")
      yield* listItems(query, userCtx, listContext, {
        modelId: ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
        stream: true,
        messages,
      })
    } else {
      yield { text: "Could not list, no results found" }
    }
  } else {
    yield { text: "Could not list, no results found" }
  }
}

// Function: answerUsingSearch
async function* answerUsingSearch(
  message: string,
  userCtx: string,
  results: VespaSearchResponse,
  modelId: Models,
): AsyncIterableIterator<{
  text?: string
  parsed?: ResultsOrRewrite
  costArr?: number[]
  initialContext?: string
  ctx?: string
}> {
  let costArr: number[] = []
  const initialContext = cleanContext(
    results.root.children
      .map(
        (v, i) =>
          `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
      )
      .join("\n"),
  )

  const iterator = analyzeInitialResultsOrRewriteV2(
    message,
    initialContext,
    userCtx,
    {
      modelId,
      stream: true,
      json: true,
    },
  )

  let buffer = ""
  for await (const chunk of iterator) {
    if (chunk.text) {
      buffer += chunk.text
      try {
        const parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite
        yield {
          text: chunk.text,
          parsed,
          costArr,
          initialContext,
          ctx: userCtx,
        }
      } catch (e) {
        // Handle partial JSON parsing
        continue
      }
    }
    if (chunk.cost) {
      costArr.push(chunk.cost)
    }
  }
}

// Function: regularRAGPipeline
async function* regularRAGPipeline(
  email: string,
  input: string,
  userCtx: string,
  results: VespaSearchResponse,
  modelId: Models,
): AsyncIterableIterator<ConverseResponse & { citations?: number[] }> {
  const message = input
  const pageSize = 10
  let costArr: number[] = []
  let initialContext = ""
  let ctx = userCtx
  let currentAnswer = ""

  // Step 1: Try to get an answer using the initial search results
  let answerIterator = answerUsingSearch(message, userCtx, results, modelId)

  let buffer = ""

  for await (const chunk of answerIterator) {
    if (chunk.text) {
      buffer += chunk.text
      try {
        const parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite

        if (parsed.answer && currentAnswer !== parsed.answer) {
          const newText = parsed.answer.slice(currentAnswer.length)
          yield { text: newText }
          currentAnswer = parsed.answer
        }
      } catch (e) {
        continue
      }
    }

    if (chunk.costArr) {
      costArr = [...costArr, ...chunk.costArr]
    }
    if (chunk.initialContext) {
      initialContext = chunk.initialContext
    }
    if (chunk.ctx) {
      ctx = chunk.ctx
    }
  }

  // Step 2: If no answer, perform additional searches and try again
  if (!currentAnswer) {
    for (let offsetMultiplier = 1; offsetMultiplier <= 2; offsetMultiplier++) {
      const newResults = await searchVespa(
        message,
        email,
        null,
        null,
        pageSize,
        pageSize * offsetMultiplier,
      )

      answerIterator = answerUsingSearch(message, userCtx, newResults, modelId)

      buffer = ""
      currentAnswer = ""

      for await (const chunk of answerIterator) {
        if (chunk.text) {
          buffer += chunk.text
          try {
            const parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite

            if (parsed.answer && currentAnswer !== parsed.answer) {
              const newText = parsed.answer.slice(currentAnswer.length)
              yield { text: newText }
              currentAnswer = parsed.answer
            }
          } catch (e) {
            continue
          }
        }

        if (chunk.costArr) {
          costArr = [...costArr, ...chunk.costArr]
        }
        if (chunk.initialContext) {
          initialContext = chunk.initialContext
        }
        if (chunk.ctx) {
          ctx = chunk.ctx
        }
      }

      if (currentAnswer) {
        break
      }
    }
  }

  // Step 3: If still no answer, handle rewritten queries
  // You can implement additional logic here if needed
}

// Function: findAnswerWithTimeRangeExpansion
async function* findAnswerWithTimeRangeExpansion(
  email: string,
  userCtx: string,
  userQuery: string,
  maxIterations: number = 3,
  messages?: Message[],
): AsyncIterableIterator<ConverseResponse & { citations?: number[] }> {
  const pageSize = 6
  const now = new Date().getTime()

  // Time range configuration (in milliseconds)
  const monthInMs = 30 * 24 * 60 * 60 * 1000
  const initialRange = 3 * monthInMs
  const rangeIncrement = 3 * monthInMs
  const maxRange = 12 * monthInMs

  let context: any[] = []
  let iterations = 0
  let costArr: number[] = []
  let seenDocIds = new Set<string>()
  let currentTimeRange = initialRange
  let currentQueries = [userQuery]
  let currentAnswer = ""

  while (iterations < maxIterations) {
    let newResults: any[] = []
    const timeRange = {
      from: now - currentTimeRange,
      to: now,
    }

    // Search with all current queries
    for (const query of currentQueries) {
      const results = await searchVespa(
        query,
        email,
        null,
        null,
        pageSize,
        0,
        timeRange,
        Array.from(seenDocIds),
        nonWorkMailLabels,
      )

      if (results.root.children) {
        results.root.children.forEach((child) => seenDocIds.add(child.id))
        newResults.push(...results.root.children)
      }
    }

    // Update context with new results
    context = [...context, ...newResults]

    const contextString = cleanContext(
      context
        .map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
        )
        .join("\n"),
    )

    const iterator = answerOrSearch(userQuery, contextString, userCtx, {
      modelId: ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
      json: true,
      stream: true,
      messages,
    })

    let buffer = ""
    let out: z.infer<typeof SearchAnswerResponse> | null = null

    for await (const chunk of iterator) {
      if (chunk.text) {
        buffer += chunk.text
        try {
          out = jsonParseLLMOutput(buffer) as z.infer<
            typeof SearchAnswerResponse
          >

          if (
            out.answer &&
            out.answer.length > 1 &&
            currentAnswer !== out.answer
          ) {
            const newText = out.answer.slice(currentAnswer.length)
            yield { text: newText }
            currentAnswer = out.answer
          }
        } catch (e) {
          continue
        }
      }
      if (chunk.cost) {
        costArr.push(chunk.cost)
      }
    }

    if (currentAnswer) {
      // Answer found, yield citations if any
      yield { citations: out?.citations ?? [] }
      break
    }

    // At 50% of max iterations, attempt regularRAGPipeline approach
    if (iterations === Math.floor(maxIterations / 2)) {
      const ragResults = await searchVespa(
        userQuery,
        email,
        null,
        null,
        pageSize,
        0,
        null,
        Array.from(seenDocIds),
        nonWorkMailLabels,
      )

      const pipelineIterator = regularRAGPipeline(
        email,
        userQuery,
        userCtx,
        ragResults,
        ragPipelineConfig[RagPipelineStages.AnswerOrSearch].modelId,
      )

      let pipelineAnswer = ""

      for await (const response of pipelineIterator) {
        if (response.text) {
          yield { text: response.text }
          pipelineAnswer += response.text
        }
        if (response.citations) {
          yield { citations: response.citations }
          break
        }
      }

      if (pipelineAnswer) {
        // Answer found via regularRAGPipeline, break out of loop
        break
      }
    }

    if (!out) {
      throw new Error("Invalid object while streaming")
    }

    // Keep useful context
    if (out.usefulIndex && out.usefulIndex.length > 0) {
      context = context.filter((_, i) => out.usefulIndex.includes(i))
    } else {
      context = []
    }

    // Update queries for next iteration
    if (out.searchQueries && out.searchQueries.length > 0) {
      currentQueries = out.searchQueries
    } else if (currentTimeRange < maxRange) {
      // If no new queries suggested, expand time range and revert to original query
      currentTimeRange += rangeIncrement
      currentQueries = [userQuery]
      // console.log(
      //   `Expanding time range to ${currentTimeRange / monthInMs} months`,
      // );
    } else {
      break
    }

    iterations++
  }
}

export async function* UnderstandMessageAndAnswer(
  email: string,
  userCtx: string,
  message: string,
  routerResponse: { result: QueryRouterResponse; cost: number },
  messages?: Message[],
): AsyncIterableIterator<ConverseResponse & { citations?: number[] }> {
  // we are removing the most recent message that was inserted
  // that is the user message, we will append our own
  messages = messages?.splice(0, messages.length - 1)
  const { result, cost } = routerResponse
  if (result.type === QueryType.RetrieveInformation) {
    let filters: { startTime: number | null; endTime: number | null } = {
      startTime: null,
      endTime: null,
    }
    if (result.filters && result.filters.startTime && result.filters.endTime) {
      if (result.filters.startTime) {
        filters.startTime = new Date(result.filters.startTime).getTime()
      }
      if (result.filters.endTime) {
        filters.endTime = new Date(result.filters.endTime).getTime()
      }
      yield* findAnswerWithinTimeRange(email, userCtx, message, filters)
    } else {
      yield* findAnswerWithTimeRangeExpansion(
        email,
        userCtx,
        message,
        8,
        messages,
      )
    }
  } else if (result.type === QueryType.ListItems) {
    yield* getListData(email, message, userCtx, result, messages)
    // }
    // else if (result.type === QueryType.RetrieveMetadata) {
    //   yield {
    //     text: "Operation to retrieve a single item's metadata is not supported yet",
    //   }
  } else {
    yield { text: "Apologies I didn't understand" }
  }
}

async function* findAnswerWithinTimeRange(
  email: string,
  userCtx: string,
  userQuery: string,
  filters: { startTime: number | null; endTime: number | null },
): AsyncIterableIterator<ConverseResponse> {
  return yield { text: "Not yet implemented", cost: 0 }
}

export const MessageApiV2 = async (c: Context) => {
  // we will use this in catch
  // if the value exists then we send the error to the frontend via it
  let stream: any
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId }: MessageReqType = body
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)

    const [userAndWorkspace] = await Promise.all([
      getUserAndWorkspaceByEmail(db, workspaceId, email),
      // searchVespa(message, email, null, null, config.answerPage, 0, null, [], nonWorkMailLabels),
    ])
    const results = { root: { children: [] } }
    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat
    const initialContext = cleanContext(
      results.root.children
        .map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
        )
        .join("\n"),
    )

    let title = ""
    if (!chatId) {
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
      }

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
          })
          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId,
          })
          return [chat, insertedMsg]
        },
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx) => {
          // we are updating the chat and getting it's value in one call itself
          let existingChat = await updateChatByExternalId(db, chatId, {})
          let allMessages = await getChatMessages(tx, chatId)
          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: [],
            message,
            modelId,
          })
          return [existingChat, allMessages, insertedMsg]
        },
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
    }

    return streamSSE(
      c,
      async (stream) => {
        try {
          if (!chatId) {
            await stream.writeSSE({
              data: title,
              event: ChatSSEvents.ChatTitleUpdate,
            })
          }

          Logger.info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })

          const routerResp = await routeQuery(message, {
            modelId: ragPipelineConfig[RagPipelineStages.QueryRouter].modelId,
            stream: false,
            messages: messages
              .map((m) => ({
                role: m.messageRole as ConversationRole,
                content: [{ text: m.message }],
              }))
              .slice(0, messages.length - 1), // removing the last one as we append ourselves inside route Query
          })
          const iterator = UnderstandMessageAndAnswer(
            email,
            ctx,
            message,
            routerResp,
            messages.map((m) => ({
              role: m.messageRole as ConversationRole,
              content: [{ text: m.message }],
            })),
          )

          stream.writeSSE({
            event: ChatSSEvents.Start,
            data: "",
          })
          let citations = []
          let answer = ""
          for await (const chunk of iterator) {
            if (chunk.text) {
              answer += chunk.text
              stream.writeSSE({
                event: ChatSSEvents.ResponseUpdate,
                data: chunk.text,
              })
            }
            if (chunk.cost) {
              costArr.push(chunk.cost)
            }
            if (chunk.citations) {
              citations = chunk.citations
            }
          }
          // let minimalContextChunks: Citation[] = []
          // const citationMap: Record<number, number> = {}
          // // TODO: this is not done yet
          // // we need to send all of it
          // if (parsed.citations) {
          //   currentCitations = parsed.citations

          //   currentCitations.forEach((v, i) => {
          //     citationMap[v] = i
          //   })
          //   minimalContextChunks = searchToCitation(
          //     results.root.children.filter((_, i) =>
          //       currentCitations.includes(i),
          //     ) as z.infer<typeof VespaSearchResultsSchema>[],
          //   )
          //   await stream.writeSSE({
          //     event: ChatSSEvents.CitationsUpdate,
          //     data: JSON.stringify({
          //       contextChunks: minimalContextChunks,
          //       citationMap,
          //     }),
          //   })
          // }
          if (answer) {
            // TODO: incase user loses permission
            // to one of the citations what do we do?
            // somehow hide that citation and change
            // the answer to reflect that
            const msg = await insertMessage(db, {
              chatId: chat.id,
              userId: user.id,
              workspaceExternalId: workspace.externalId,
              chatExternalId: chat.externalId,
              messageRole: MessageRole.Assistant,
              email: user.email,
              // sources: minimalContextChunks,
              message: answer, //processMessage(parsed.answer, citationMap),
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
            })
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: msg.externalId,
              }),
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          } else {
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: "Error while trying to answer",
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          }
        } catch (error) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: (error as Error).message,
          })
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
        }
      },
      async (err, stream) => {
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: err.message,
        })
        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(`Streaming Error: ${err.message} ${(err as Error).stack}`)
      },
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    // TODO: add more errors like bedrock, this is only openai
    if (error instanceof APIError) {
      // quota error
      if (error.status === 429) {
        console.error("You exceeded your current quota,")
        if (stream) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: error.message,
          })
        }
      }
    } else {
      Logger.error(`Message Error: ${errMsg} ${(error as Error).stack}`)
      throw new HTTPException(500, {
        message: "Could not create message or Chat",
      })
    }
  }
}

export const MessageApi = async (c: Context) => {
  try {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("query")
    let { message, chatId, modelId, attachments }: MessageReqType = body
    if (!message) {
      throw new HTTPException(400, {
        message: "Message is required",
      })
    }
    message = decodeURIComponent(message)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )

    const { user, workspace } = userAndWorkspace
    let messages: SelectMessage[] = []
    const costArr: number[] = []
    const ctx = userContext(userAndWorkspace)
    let chat: SelectChat

    let title = ""
    if (!chatId) {
      // let llm decide a title
      const titleResp = await generateTitleUsingQuery(message, {
        modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
        stream: false,
      })
      title = titleResp.title
      const cost = titleResp.cost
      if (cost) {
        costArr.push(cost)
      }

      let [insertedChat, insertedMsg] = await db.transaction(
        async (tx): Promise<[SelectChat, SelectMessage]> => {
          const attachmentsToBeInserted = JSON.parse(attachments) || []
          const chat = await insertChat(tx, {
            workspaceId: workspace.id,
            workspaceExternalId: workspace.externalId,
            userId: user.id,
            email: user.email,
            title,
            attachments: [],
            hasAttachments: attachmentsToBeInserted?.length > 0 ? true : false,
          })
          const insertedMsg = await insertMessage(tx, {
            chatId: chat.id,
            userId: user.id,
            chatExternalId: chat.externalId,
            workspaceExternalId: workspace.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: attachmentsToBeInserted, // Adding attachmentMetadata to sources
            attachments: attachmentsToBeInserted,
            message,
            modelId,
          })
          // Add this to chatAttachments in vespa
          const chatExtId = chat.externalId
          const messageExtId = insertedMsg.externalId
          for (const attachment of attachmentsToBeInserted) {
            const attachmentId = attachment?.docId
            await AddChatMessageIdToAttachment(
              chatAttachmentSchema,
              attachmentId,
              chatExtId,
              messageExtId,
            )
          }

          return [chat, insertedMsg]
        },
      )
      chat = insertedChat
      messages.push(insertedMsg) // Add the inserted message to messages array
    } else {
      let [existingChat, allMessages, insertedMsg] = await db.transaction(
        async (tx) => {
          const newAttachments = JSON.parse(attachments) || []

          const oldChat = await getChatByExternalId(db, chatId)
          const alreadyHasAttachments = oldChat?.hasAttachments
          const hasAttachmentsNow = newAttachments?.length > 0 ? true : false

          // we are updating the chat and getting it's value in one call itself
          let existingChat = await updateChatByExternalId(
            db,
            chatId,
            alreadyHasAttachments
              ? {}
              : hasAttachmentsNow
                ? { hasAttachments: hasAttachmentsNow }
                : {},
          )
          let allMessages = await getChatMessages(tx, chatId)
          let insertedMsg = await insertMessage(tx, {
            chatId: existingChat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: existingChat.externalId,
            messageRole: MessageRole.User,
            email: user.email,
            sources: newAttachments, // Adding new attachments metadata
            attachments: newAttachments,
            message,
            modelId,
          })

          // Add this to chatAttachments in vespa
          const chatExtId = existingChat.externalId
          const messageExtId = insertedMsg.externalId
          for (const attachment of newAttachments) {
            const attachmentId = attachment?.docId
            await AddChatMessageIdToAttachment(
              chatAttachmentSchema,
              attachmentId,
              chatExtId,
              messageExtId,
            )
          }

          return [existingChat, allMessages, insertedMsg]
        },
      )
      messages = allMessages.concat(insertedMsg) // Update messages array
      chat = existingChat
    }

    // Condition to decide if searchVespa function will be used to search or searchVespaWithChatAttachment
    // If Chat has attachment then we use searchVespaWithChatAttachment, otherwise searchVespa

    // Check if the current chat has attachments
    const currentChat = await db.transaction(async (tx) => {
      let currentChat = await getChatByExternalId(tx, chat?.externalId)
      return currentChat
    })
    const currentChatHasAttachments = currentChat?.hasAttachments

    let results: VespaSearchResponse
    if (currentChatHasAttachments) {
      results = await searchVespaWithChatAttachment(
        message,
        email,
        chat?.externalId,
        config.answerPage,
      )
    } else {
      results = await searchVespa(
        message,
        email,
        null,
        null,
        config.answerPage,
        0,
        null,
        [],
        nonWorkMailLabels,
      )
    }

    const initialContext = cleanContext(
      results?.root?.children
        ?.map(
          (v, i) =>
            `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
        )
        .join("\n"),
    )

    return streamSSE(
      c,
      async (stream) => {
        try {
          if (!chatId) {
            await stream.writeSSE({
              data: title,
              event: ChatSSEvents.ChatTitleUpdate,
            })
          }

          Logger.info("Chat stream started")
          // we do not set the message Id as we don't have it
          await stream.writeSSE({
            event: ChatSSEvents.ResponseMetadata,
            data: JSON.stringify({
              chatId: chat.externalId,
            }),
          })
          const iterator = analyzeInitialResultsOrRewrite(
            message,
            initialContext,
            ctx,
            {
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
              stream: true,
              json: true,
              messages: messages.map((m) => ({
                role: m.messageRole as ConversationRole,
                content: [{ text: m.message }],
              })),
            },
          )
          // prev response so we can find the diff
          let currentAnswer = ""
          // accumulator
          let buffer = ""
          let currentCitations: number[] = []
          // will contain the streamed partial json
          let parsed: ResultsOrRewrite = {
            answer: "",
            citations: [],
            rewrittenQueries: [],
          }
          for await (const chunk of iterator) {
            try {
              if (chunk.text) {
                buffer += chunk.text
                parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite
                // answer is there and it is coming
                // we will stream it to the user
                if (parsed.answer && currentAnswer !== parsed.answer) {
                  // first time
                  if (!currentAnswer) {
                    stream.writeSSE({
                      event: ChatSSEvents.Start,
                      data: "",
                    })
                  }
                  stream.writeSSE({
                    event: ChatSSEvents.ResponseUpdate,
                    data: parsed.answer.slice(currentAnswer.length),
                  })
                  currentAnswer = parsed.answer
                }
                if (chunk.metadata?.cost) {
                  costArr.push(chunk.metadata.cost)
                }
              }
            } catch (e) {
              continue
            }
          }
          let minimalContextChunks: Citation[] = []
          const citationMap: Record<number, number> = {}
          // TODO: this is not done yet
          // we need to send all of it
          if (parsed.citations) {
            currentCitations = parsed.citations

            currentCitations.forEach((v, i) => {
              citationMap[v] = i
            })
            minimalContextChunks = searchToCitation(
              results?.root?.children?.filter((_, i) =>
                currentCitations.includes(i),
              ) as z.infer<typeof VespaSearchResultsSchema>[],
            )
            await stream.writeSSE({
              event: ChatSSEvents.CitationsUpdate,
              data: JSON.stringify({
                contextChunks: minimalContextChunks,
                citationMap,
              }),
            })
          }
          if (parsed.answer) {
            // TODO: incase user loses permission
            // to one of the citations what do we do?
            // somehow hide that citation and change
            // the answer to reflect that
            const msg = await insertMessage(db, {
              chatId: chat.id,
              userId: user.id,
              workspaceExternalId: workspace.externalId,
              chatExternalId: chat.externalId,
              messageRole: MessageRole.Assistant,
              email: user.email,
              sources: minimalContextChunks,
              message: processMessage(parsed.answer, citationMap),
              modelId:
                ragPipelineConfig[RagPipelineStages.AnswerOrRewrite].modelId,
            })
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: msg.externalId,
              }),
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          } else if (parsed.rewrittenQueries) {
            let finalContext = initialContext
            const allResults = (
              await Promise.all(
                parsed.rewrittenQueries.map((newQuery: string) =>
                  // todo for @Saheb
                  // Should the condition (if chat has attachments) determine
                  // whether to use searchVespa or searchVespaWithChatAttachment here?
                  searchVespa(
                    newQuery,
                    email,
                    null,
                    null,
                    5,
                    0,
                    null,
                    results.root.children.map(
                      (v) =>
                        (v as z.infer<typeof VespaSearchResultsSchema>).fields
                          .docId,
                    ),
                    nonWorkMailLabels,
                  ),
                ),
              )
            )
              .map((v) => v.root.children)
              .flat()
            const idSet = new Set()
            const uniqueResults = []
            for (const res of allResults) {
              if (!idSet.has(res.id)) {
                idSet.add(res.id)
                uniqueResults.push(res)
              }
            }
            finalContext = cleanContext(
              uniqueResults
                .map(
                  (v, i) =>
                    `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
                )
                .join("\n"),
            )
            const iterator = askQuestionWithCitations(
              message,
              ctx,
              finalContext,
              {
                modelId:
                  ragPipelineConfig[RagPipelineStages.RewriteAndAnswer].modelId,
                userCtx: ctx,
                stream: true,
                json: true,
                messages: messages.map((m) => ({
                  role: m.messageRole as ConversationRole,
                  content: [{ text: m.message }],
                })),
              },
            )
            let buffer = ""
            let currentAnswer = ""
            let currentCitations: number[] = []

            for await (const chunk of iterator) {
              try {
                if (chunk.text) {
                  buffer += chunk.text
                  parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite

                  // Stream new answer content
                  if (parsed.answer && parsed.answer !== currentAnswer) {
                    const newContent = parsed.answer.slice(currentAnswer.length)
                    currentAnswer = parsed.answer
                    await stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: newContent,
                    })
                  }

                  let minimalContextChunks: Citation[] = []
                  const citationMap: Record<number, number> = {}
                  // Stream citation updates
                  if (parsed.citations) {
                    currentCitations = parsed.citations
                    currentCitations.forEach((v, i) => {
                      citationMap[v] = i
                    })
                    minimalContextChunks = searchToCitation(
                      results.root.children.filter((_, i) =>
                        currentCitations.includes(i),
                      ) as z.infer<typeof VespaSearchResultsSchema>[],
                    )

                    // citations count should match the minimalContext chunks
                    await stream.writeSSE({
                      event: ChatSSEvents.CitationsUpdate,
                      data: JSON.stringify({
                        contextChunks: minimalContextChunks,
                        citationMap,
                      }),
                    })
                  }
                }
                if (chunk.metadata?.cost) {
                  costArr.push(chunk.metadata.cost)
                }
              } catch (e) {
                continue
              }
            }
            const msg = await insertMessage(db, {
              chatId: chat.id,
              userId: user.id,
              workspaceExternalId: workspace.externalId,
              chatExternalId: chat.externalId,
              messageRole: MessageRole.Assistant,
              email: user.email,
              sources: minimalContextChunks,
              message: processMessage(parsed.answer!, citationMap),
              modelId:
                ragPipelineConfig[RagPipelineStages.RewriteAndAnswer].modelId,
            })
            await stream.writeSSE({
              event: ChatSSEvents.ResponseMetadata,
              data: JSON.stringify({
                chatId: chat.externalId,
                messageId: msg.externalId,
              }),
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          } else {
            await stream.writeSSE({
              event: ChatSSEvents.Error,
              data: "Error while trying to answer",
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          }
        } catch (error) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: (error as Error).message,
          })
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
        }
      },
      async (err, stream) => {
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: err.message,
        })
        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(`Streaming Error: ${err.message} ${(err as Error).stack}`)
      },
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Message Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not create message or Chat",
    })
  }
}

export const MessageRetryApi = async (c: Context) => {
  try {
    // @ts-ignore
    const body = c.req.valid("query")
    const { messageId } = body

    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub

    const costArr: number[] = []
    // Fetch the original message
    const originalMessage = await getMessageByExternalId(db, messageId)
    if (!originalMessage) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    // Fetch the chat and previous messages
    // const chat = await getChatByExternalId(db, originalMessage.chatExternalId)
    let conversation = await getChatMessagesBefore(
      db,
      originalMessage.chatId,
      originalMessage.createdAt,
    )
    if (!conversation || !conversation.length) {
      throw new HTTPException(400, {
        message: "Could not fetch previous messages",
      })
    }

    // Use the same modelId
    const modelId = originalMessage.modelId as Models

    // Get user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const ctx = userContext(userAndWorkspace)

    let newCitations: Citation[] = []
    // the last message before our assistant's message was the user's message
    const prevUserMessage = conversation[conversation.length - 1]
    // we are trying to retry the first assistant's message
    if (conversation.length === 1) {
      conversation = []
    }
    if (!prevUserMessage.message) {
      throw new HTTPException(400, {
        message: "Cannot retry the message, invalid user chat",
      })
    }

    return streamSSE(
      c,
      async (stream) => {
        try {
          // if we have citations we will have to do search again
          // and then go through the original pipeline
          if (
            originalMessage.sources &&
            (originalMessage.sources as Citation[]).length
          ) {
            const results = await searchVespa(
              prevUserMessage.message,
              email,
              null,
              null,
              config.answerPage,
              0,
              null,
              [],
              nonWorkMailLabels,
            )
            const initialContext = cleanContext(
              results.root.children
                .map((v) =>
                  answerContextMap(
                    v as z.infer<typeof VespaSearchResultsSchema>,
                  ),
                )
                .join("\n"),
            )

            const iterator = analyzeInitialResultsOrRewrite(
              prevUserMessage.message,
              initialContext,
              ctx,
              {
                modelId,
                stream: true,
                json: true,
                messages: conversation.map((m) => ({
                  role: m.messageRole as ConversationRole,
                  content: [{ text: m.message }],
                })),
              },
            )
            // prev response so we can find the diff
            let currentAnswer = ""
            // accumulator
            let buffer = ""
            let currentCitations: number[] = []
            // will contain the streamed partial json
            let parsed: ResultsOrRewrite = {
              answer: "",
              citations: [],
              rewrittenQueries: [],
            }
            for await (const chunk of iterator) {
              try {
                if (chunk.text) {
                  buffer += chunk.text
                  parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite
                  // answer is there and it is coming
                  // we will stream it to the user
                  if (parsed.answer && currentAnswer !== parsed.answer) {
                    // first time
                    if (!currentAnswer) {
                      stream.writeSSE({
                        event: ChatSSEvents.Start,
                        data: "",
                      })
                    }
                    stream.writeSSE({
                      event: ChatSSEvents.ResponseUpdate,
                      data: parsed.answer.slice(currentAnswer.length),
                    })
                    currentAnswer = parsed.answer
                  }
                  if (chunk.metadata?.cost) {
                    costArr.push(chunk.metadata.cost)
                  }
                }
              } catch (e) {
                continue
              }
            }
            let minimalContextChunks: Citation[] = []
            const citationMap: Record<number, number> = {}
            // TODO: this is not done yet
            // we need to send all of it
            if (parsed.citations) {
              currentCitations = parsed.citations
              currentCitations.forEach((v, i) => {
                citationMap[v] = i
              })
              minimalContextChunks = searchToCitation(
                results.root.children.filter((_, i) =>
                  currentCitations.includes(i),
                ) as z.infer<typeof VespaSearchResultsSchema>[],
              )
              await stream.writeSSE({
                event: ChatSSEvents.CitationsUpdate,
                data: JSON.stringify({
                  contextChunks: minimalContextChunks,
                  citationMap,
                }),
              })
            }
            if (parsed.answer) {
              let newMessageContent = parsed.answer
              // Update the assistant's message with new content and updatedAt
              await updateMessage(db, messageId, {
                message: processMessage(newMessageContent, citationMap),
                updatedAt: new Date(),
                sources: minimalContextChunks,
              })
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
            } else if (parsed.rewrittenQueries) {
              let finalContext = initialContext
              const allResults = (
                await Promise.all(
                  parsed.rewrittenQueries.map((newQuery: string) =>
                    searchVespa(
                      newQuery,
                      email,
                      null,
                      null,
                      5,
                      0,
                      null,
                      results.root.children.map(
                        (v) =>
                          (v as z.infer<typeof VespaSearchResultsSchema>).fields
                            .docId,
                      ),
                      nonWorkMailLabels,
                    ),
                  ),
                )
              )
                .map((v) => v.root.children)
                .flat()
              const idSet = new Set()
              const uniqueResults = []
              for (const res of allResults) {
                if (!idSet.has(res.id)) {
                  idSet.add(res.id)
                  uniqueResults.push(res)
                }
              }
              finalContext = cleanContext(
                uniqueResults
                  .map(
                    (v, i) =>
                      `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
                  )
                  .join("\n"),
              )
              const iterator = askQuestionWithCitations(
                prevUserMessage.message,
                ctx,
                finalContext,
                {
                  modelId,
                  userCtx: ctx,
                  stream: true,
                  json: true,
                  messages: conversation.map((m) => ({
                    role: m.messageRole as ConversationRole,
                    content: [{ text: m.message }],
                  })),
                },
              )
              let buffer = ""
              let currentAnswer = ""
              let currentCitations: number[] = []

              for await (const chunk of iterator) {
                try {
                  if (chunk.text) {
                    buffer += chunk.text
                    parsed = jsonParseLLMOutput(buffer) as ResultsOrRewrite

                    // Stream new answer content
                    if (parsed.answer && parsed.answer !== currentAnswer) {
                      const newContent = parsed.answer.slice(
                        currentAnswer.length,
                      )
                      currentAnswer = parsed.answer
                      await stream.writeSSE({
                        event: ChatSSEvents.ResponseUpdate,
                        data: newContent,
                      })
                    }
                  }
                  if (chunk.metadata?.cost) {
                    costArr.push(chunk.metadata.cost)
                  }
                } catch (e) {
                  continue
                }
              }
              let minimalContextChunks: Citation[] = []
              const citationMap: Record<number, number> = {}
              // Stream citation updates
              if (parsed.citations) {
                currentCitations = parsed.citations
                currentCitations.forEach((v, i) => {
                  citationMap[v] = i
                })
                minimalContextChunks = searchToCitation(
                  results.root.children.filter((_, i) =>
                    currentCitations.includes(i),
                  ) as z.infer<typeof VespaSearchResultsSchema>[],
                )

                // citations count should match the minimalContext chunks
                await stream.writeSSE({
                  event: ChatSSEvents.CitationsUpdate,
                  data: JSON.stringify({
                    contextChunks: minimalContextChunks,
                    citationMap,
                  }),
                })
              }
              let newMessageContent = parsed.answer
              // Update the assistant's message with new content and updatedAt
              await updateMessage(db, messageId, {
                message: processMessage(newMessageContent!, citationMap),
                updatedAt: new Date(),
                sources: minimalContextChunks,
              })
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
            } else {
              await stream.writeSSE({
                event: ChatSSEvents.Error,
                data: "Error while trying to answer",
              })
              await stream.writeSSE({
                data: "",
                event: ChatSSEvents.End,
              })
            }
          } else {
            // there were no citations so we will only use the conversation history to answer the user
            const iterator = userChat(prevUserMessage.message, {
              modelId,
              stream: true,
              messages: conversation.map((m) => ({
                role: m.messageRole as ConversationRole,
                content: [{ text: m.message }],
              })),
            })
            stream.writeSSE({
              event: ChatSSEvents.Start,
              data: "",
            })
            let newMessageContent = ""
            for await (const chunk of iterator) {
              if (chunk.text) {
                newMessageContent += chunk.text
                await stream.writeSSE({
                  event: ChatSSEvents.ResponseUpdate,
                  data: chunk.text,
                })
              }
              if (chunk.metadata?.cost) {
                costArr.push(chunk.metadata.cost)
              }
            }
            await updateMessage(db, messageId, {
              message: newMessageContent,
              updatedAt: new Date(),
              sources: [],
            })
            await stream.writeSSE({
              data: "",
              event: ChatSSEvents.End,
            })
          }
        } catch (error) {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: (error as Error).message,
          })
          await stream.writeSSE({
            data: "",
            event: ChatSSEvents.End,
          })
          Logger.error(
            `Streaming Error: ${(error as Error).message} ${(error as Error).stack}`,
          )
        }
      },
      async (err, stream) => {
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: err.message,
        })
        await stream.writeSSE({
          data: "",
          event: ChatSSEvents.End,
        })
        Logger.error(`Streaming Error: ${err.message} ${(err as Error).stack}`)
      },
    )
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(`Message Retry Error: ${errMsg} ${(error as Error).stack}`)
    throw new HTTPException(500, {
      message: "Could not retry message",
    })
  }
}
