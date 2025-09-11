import { type Message } from "@aws-sdk/client-bedrock-runtime"
import OpenAI from "openai"
import { isDeepResearchModel, modelDetailsMap } from "@/ai/mappers"
import type { ConverseResponse, ModelParams } from "@/ai/types"
import { AIProviders, Models } from "@/ai/types"
import BaseProvider, { regex } from "@/ai/provider/base"
import { calculateCost } from "@/utils/index"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import fs from "fs"
import path from "path"
import { findImageByName } from "@/ai/provider/base"

const Logger = getLogger(Subsystem.AI)

// Helper function to convert images to OpenAI format
const buildOpenAIImageParts = async (imagePaths: string[]) => {
  const baseDir = path.resolve(
    process.env.IMAGE_DIR || "downloads/xyne_images_db",
  )

  const imagePromises = imagePaths.map(async (imgPath) => {
    const match = imgPath.match(regex)
    if (!match) {
      Logger.error(
        `Invalid image path format: ${imgPath}. Expected format: docIndex_docId_imageNumber`,
      )
      throw new Error(`Invalid image path: ${imgPath}`)
    }

    const docIndex = match[1]
    const docId = match[2]
    const imageNumber = match[3]

    if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
      Logger.error(`Invalid docId containing path traversal: ${docId}`)
      throw new Error(`Invalid docId: ${docId}`)
    }

    const imageDir = path.join(baseDir, docId)
    const absolutePath = findImageByName(imageDir, imageNumber)
    const extension = path.extname(absolutePath).toLowerCase()

    // Map file extensions to MIME types for OpenAI
    const mimeTypeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    }

    const mimeType = mimeTypeMap[extension]
    if (!mimeType) {
      Logger.warn(
        `Unsupported image format: ${extension}. Skipping image: ${absolutePath}`,
      )
      return null
    }

    // Ensure the resolved path is within baseDir
    const resolvedPath = path.resolve(imageDir)
    if (!resolvedPath.startsWith(baseDir)) {
      Logger.error(`Path traversal attempt detected: ${imageDir}`)
      throw new Error(`Invalid path: ${imageDir}`)
    }

    try {
      // Check if file exists before trying to read it
      await fs.promises.access(absolutePath, fs.constants.F_OK)
      const imageBytes = await fs.promises.readFile(absolutePath)

      // Check file size (4MB limit for OpenAI)
      if (imageBytes.length > 4 * 1024 * 1024) {
        Logger.warn(
          `Image buffer too large after read (${imageBytes.length} bytes, ${(imageBytes.length / (1024 * 1024)).toFixed(2)}MB): ${absolutePath}. Skipping this image.`,
        )
        return null
      }

      const base64Data = imageBytes.toString("base64")

      return {
        type: "image_url" as const,
        image_url: {
          url: `data:${mimeType};base64,${base64Data}`,
        },
      }
    } catch (error) {
      Logger.error(
        `Failed to read image file ${absolutePath}: ${error instanceof Error ? error.message : error}`,
      )
      throw error
    }
  })

  const results = await Promise.all(imagePromises)
  return results.filter(Boolean) // Remove any null/undefined entries
}

const extractSearchDetails = (item: any) => {
  const action =
    item.action || item.call?.action || item.function_call?.arguments

  if (!action) return null

  let parsedAction = action
  if (typeof action === "string") {
    try {
      parsedAction = JSON.parse(action)
    } catch (e) {
      return null
    }
  }

  if (parsedAction.query) {
    return { query: parsedAction.query, type: "search" }
  }

  if (parsedAction.url) {
    const domain =
      parsedAction.url.match(/https?:\/\/([^\/]+)/)?.[1] || parsedAction.url
    return { url: parsedAction.url, domain, type: "open_page" }
  }

  return null
}

const createEventMetadata = (type: string, event: any, extras: any = {}) => ({
  type,
  sequence_number: event.sequence_number,
  ...extras,
})

export class OpenAIProvider extends BaseProvider {
  constructor(client: OpenAI) {
    super(client, AIProviders.OpenAI)
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    // Build image parts if they exist
    const imageParts =
      params.imageFileNames && params.imageFileNames.length > 0
        ? await buildOpenAIImageParts(params.imageFileNames)
        : []

    // Find the last user message index to add images only to that message
    const lastUserMessageIndex =
      messages
        .map((m, idx) => ({ message: m, index: idx }))
        .reverse()
        .find(({ message }) => message.role === "user")?.index ?? -1

    // Transform messages to include images only in the last user message
    const transformedMessages: any[] = messages.map((message, index) => {
      const role = message.role === "assistant" ? "assistant" : "user"

      if (
        index === lastUserMessageIndex &&
        imageParts.length > 0 &&
        role === "user"
      ) {
        // Combine image context instruction with user's message text
        const userText = message.content![0].text!
        const combinedText =
          "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n" +
          userText

        return {
          role: "user" as const,
          content: [
            { type: "text" as const, text: combinedText },
            ...imageParts,
          ],
        }
      }
      return {
        role,
        content: message.content![0].text!,
      }
    })
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            modelParams.systemPrompt! +
            "\n\n" +
            "Important: In case you don't have the context, you can use the images in the context to answer questions.",
        },
        ...transformedMessages,
      ],
      model: modelParams.modelId,
      stream: false,
      max_tokens: modelParams.maxTokens,
      temperature: modelParams.temperature,
      top_p: modelParams.topP,
      // tool calling support
      tools: params.tools
        ? params.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters || { type: "object", properties: {} },
            },
          }))
        : undefined,
      tool_choice: params.tools ? (params.tool_choice ?? "auto") : undefined,
      parallel_tool_calls: params.tools
        ? params.parallel_tool_calls ?? true
        : undefined,
      ...(modelParams.json ? { response_format: { type: "json_object" } } : {}),
    })
    const choice = chatCompletion.choices[0]
    const fullResponse = choice.message?.content || ""
    const toolCalls = (choice.message?.tool_calls || []).map((tc) => ({
      id: (tc as any).id || "",
      type: "function" as const,
      function: {
        name: (tc as any).function?.name || "",
        arguments: (tc as any).function?.arguments || "{}",
      },
    }))
    const cost = calculateCost(
      {
        inputTokens: chatCompletion.usage?.prompt_tokens!,
        outputTokens: chatCompletion.usage?.completion_tokens!,
      },
      modelDetailsMap[modelParams.modelId].cost.onDemand,
    )
    return {
      text: fullResponse,
      cost,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = this.getModelParams(params)

    // Build image parts if they exist
    const imageParts =
      params.imageFileNames && params.imageFileNames.length > 0
        ? await buildOpenAIImageParts(params.imageFileNames)
        : []

    // Find the last user message index to add images only to that message
    const lastUserMessageIndex =
      messages
        .map((m, idx) => ({ message: m, index: idx }))
        .reverse()
        .find(({ message }) => message.role === "user")?.index ?? -1

    // Transform messages to include images only in the last user message
    const transformedMessages: any[] = messages.map((message, index) => {
      const role = message.role === "assistant" ? "assistant" : "user"

      if (
        index === lastUserMessageIndex &&
        imageParts.length > 0 &&
        role === "user"
      ) {
        // Combine image context instruction with user's message text
        const userText = message.content![0].text!
        const combinedText =
          "You may receive image(s) as part of the conversation. If images are attached, treat them as essential context for the user's question.\n\n" +
          userText

        return {
          role: "user" as const,
          content: [
            { type: "text" as const, text: combinedText },
            ...imageParts,
          ],
        }
      }
      return {
        role,
        content: message.content![0].text!,
      }
    })

    const responseStream = await (this.client as OpenAI).responses.stream({
      model: params.modelId,
      input: [
        {
          role: "system",
          content:
            modelParams.systemPrompt! +
            "\n\n" +
            "Important: In case you don't have the context, you can use the images in the context to answer questions.",
        },
        ...transformedMessages,
      ],
      ...(!isDeepResearchModel(modelParams.modelId as Models) &&
      !params.deepResearchEnabled
        ? {
            stream: true,
            temperature: modelParams.temperature,
            top_p: modelParams.topP,
          }
        : {
            tools: [
              {
                type: "web_search_preview",
              },
            ],
            max_tool_calls: 100,
            reasoning: {
              summary: "detailed",
              effort: "medium",
            },
          }),
    })

    let costYielded = false
    let reasoningSteps: Map<string, string> = new Map() // Track reasoning content by ID

    for await (const event of responseStream) {
      switch (event.type) {
        case "response.created":
          yield {
            text: "",
            metadata: createEventMetadata("response.created", event, {
              status: event.response.status,
            }),
          }
          break

        case "response.output_item.added":
          const addedItem = event.item
          let addedDisplayText = ""

          if (addedItem.type === "reasoning") {
            // Initialize reasoning content for this item
            reasoningSteps.set(addedItem.id, "")
            addedDisplayText = "Starting reasoning process..."
          } else if (addedItem.type === "web_search_call") {
            addedDisplayText = "Initiating web search..."
          }

          yield {
            text: "",
            metadata: createEventMetadata("response.output_item.added", event, {
              output_index: event.output_index,
              item: event.item,
              displayText: addedDisplayText,
            }),
          }
          break

        case "response.output_item.done":
          const doneItem = event.item
          let doneDisplayText = ""
          let searchDetails = null
          let citationData = null

          if (doneItem.type === "reasoning") {
            const reasoningContent = reasoningSteps.get(doneItem.id) || ""
            doneDisplayText = `Reasoning complete${reasoningContent ? ` (${reasoningContent.length} chars)` : ""}`
          } else if (doneItem.type === "web_search_call") {
            searchDetails = extractSearchDetails(doneItem)
            doneDisplayText = searchDetails?.query
              ? `Searched: "${searchDetails.query}"`
              : searchDetails?.domain
                ? `Opened page: ${searchDetails.domain}`
                : "Web search completed"
          } else if (doneItem.type === "message" && doneItem.content) {
            for (const content of doneItem.content) {
              if (content.type === "output_text" && content.annotations) {
                citationData = content.annotations.filter(
                  (annotation) => annotation.type === "url_citation",
                )
                if (citationData.length > 0) {
                  doneDisplayText = `Found ${citationData.length} citation${citationData.length > 1 ? "s" : ""}`
                }
              }
            }
          }

          yield {
            text: "",
            metadata: createEventMetadata("response.output_item.done", event, {
              output_index: event.output_index,
              item: event.item,
              displayText: doneDisplayText,
              searchDetails,
              citationData,
            }),
          }
          break

        case "response.output_text.delta":
          yield {
            text: event.delta,
            metadata: "",
          }
          break

        case "response.reasoning_text.delta":
          // Accumulate reasoning text for the current reasoning step
          const deltaEvent = event as any

          if (deltaEvent.item_id && deltaEvent.delta) {
            const currentContent = reasoningSteps.get(deltaEvent.item_id) || ""
            reasoningSteps.set(
              deltaEvent.item_id,
              currentContent + deltaEvent.delta,
            )
          }

          yield {
            text: "",
            metadata: createEventMetadata(
              "response.reasoning_text.delta",
              event,
              {
                delta: event.delta,
                displayText: event.delta,
                reasoning: true,
                item_id: deltaEvent.item_id,
              },
            ),
          }
          break

        case "response.reasoning_summary_text.delta":
          const summaryDeltaEvent = event as any

          if (summaryDeltaEvent.item_id && summaryDeltaEvent.delta) {
            const currentContent =
              reasoningSteps.get(summaryDeltaEvent.item_id) || ""
            reasoningSteps.set(
              summaryDeltaEvent.item_id,
              currentContent + summaryDeltaEvent.delta,
            )
          }

          yield {
            text: "",
            metadata: createEventMetadata(
              "response.reasoning_summary_text.delta",
              event,
              {
                delta: summaryDeltaEvent.delta,
                displayText: summaryDeltaEvent.delta,
                reasoning: true,
                item_id: summaryDeltaEvent.item_id,
                summary_index: summaryDeltaEvent.summary_index,
              },
            ),
          }
          break

        case "response.reasoning_text.done":
          const doneReasoningEvent = event as any

          const finalReasoningContent =
            reasoningSteps.get(doneReasoningEvent.item_id) || ""

          yield {
            text: "",
            metadata: createEventMetadata(
              "response.reasoning_text.done",
              event,
              {
                displayText: "Finished reasoning step",
                item_id: doneReasoningEvent.item_id,
                reasoningContent: finalReasoningContent,
              },
            ),
          }
          break

        case "response.reasoning_summary_text.done":
          const doneSummaryEvent = event as any
          const finalSummaryContent =
            reasoningSteps.get(doneSummaryEvent.item_id) || ""

          yield {
            text: "",
            metadata: createEventMetadata(
              "response.reasoning_summary_text.done",
              event,
              {
                displayText: `Finished reasoning summary (${finalSummaryContent.length} chars)`,
                item_id: doneSummaryEvent.item_id,
                reasoningContent: finalSummaryContent,
                summary_index: doneSummaryEvent.summary_index,
              },
            ),
          }
          break

        case "response.completed":
          // Check if reasoning content is available in the completed response
          const completedResponse = (event as any).response

          // Check each output item for reasoning content
          if (completedResponse?.output) {
            completedResponse.output.forEach((item: any, index: number) => {
              if (item.type === "reasoning") {
                if (item.content || item.text || item.reasoning) {
                }
              }
            })
          }

          if (event.response.usage && !costYielded) {
            costYielded = true
            yield {
              text: "",
              metadata: "",
              cost: calculateCost(
                {
                  inputTokens: event.response.usage.input_tokens,
                  outputTokens: event.response.usage.output_tokens,
                },
                modelDetailsMap[modelParams.modelId].cost.onDemand,
              ),
            }
          }
          yield {
            text: "",
            metadata: "stop",
          }
          break

        case "response.in_progress":
        case "response.web_search_call.in_progress":
        case "response.web_search_call.searching":
        case "response.web_search_call.completed":
          // Handle web search progress events
          const progressDisplayText = event.type.includes("searching")
            ? "Actively searching the web..."
            : event.type.includes("completed")
              ? "Web search completed successfully"
              : "Web search in progress..."

          yield {
            text: "",
            metadata: createEventMetadata(event.type, event, {
              displayText: progressDisplayText,
              ...(event.type !== "response.in_progress" && {
                output_index: (event as any).output_index,
                item_id: (event as any).item_id,
              }),
            }),
          }
          break

        default:
          // Handle other event types with simplified logic
          if (event.type.includes("in_progress")) {
            yield {
              text: "",
              metadata: createEventMetadata(event.type, event, {
                displayText: "Deep research process is actively running...",
              }),
            }
          }
          break
      }
    }
  }
}
