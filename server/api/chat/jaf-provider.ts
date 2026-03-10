import fs from "fs"
import path from "path"
import { ModelToProviderMap } from "@/ai/mappers"
import { MODEL_CONFIGURATIONS } from "@/ai/modelConfig"
import { getAISDKProviderByModel } from "@/ai/provider"
import { findImageByName, regex } from "@/ai/provider/base"
import { AIProviders, Models } from "@/ai/types"
import config from "@/config"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FilePart,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2ReasoningPart,
  LanguageModelV2TextPart,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolCallPart,
  LanguageModelV2ToolChoice,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider"
import type {
  Agent as JAFAgent,
  Message as JAFMessage,
  ModelProvider as JAFModelProvider,
} from "@xynehq/jaf"
import { getTextContent } from "@xynehq/jaf"
import OpenAI from "openai"
import type { AgentRunContext } from "./agent-schemas"
import { raceWithStop, throwIfStopRequested } from "./agent-stop"
import { zodSchemaToJsonSchema } from "./jaf-provider-utils"
import { getRecentImagesFromContext } from "./runContextUtils"
const { IMAGE_CONTEXT_CONFIG } = config
const IMAGE_BASE_DIR = path.resolve(
  process.env.IMAGE_DIR || "downloads/xyne_images_db",
)
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MIME_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const Logger = getLogger(Subsystem.Chat).child({ module: "jaf-provider" })
const loggerWithChild = getLoggerWithChild(Subsystem.Chat, {
  module: "jaf-provider",
})
const MIN_TURN_NUMBER = 1
const normalizeTurnNumber = (turn?: number | null): number =>
  typeof turn === "number" && turn >= MIN_TURN_NUMBER ? turn : MIN_TURN_NUMBER

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

type ImagePromptPart = {
  label: string
  filePart: LanguageModelV2FilePart
}

const findLastUserMessageIndex = (
  messages: LanguageModelV2Message[],
): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return i
    }
  }
  return -1
}

const parseImageFileName = (
  imageName: string,
): { docIndex: string; docId: string; imageNumber: string } | null => {
  const match = imageName.match(regex)
  if (!match) {
    Logger.debug({ imageName }, "Invalid image reference")
    return null
  }
  const [, docIndex, docId, imageNumber] = match
  if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
    Logger.warn(
      { docId, imageName },
      "Suspicious docId detected in image reference",
    )
    return null
  }
  if (
    imageNumber.includes("..") ||
    imageNumber.includes("/") ||
    imageNumber.includes("\\")
  ) {
    Logger.warn(
      { imageName, imageNumber },
      "Suspicious imageNumber detected in image reference",
    )
    return null
  }

  return { docIndex, docId, imageNumber }
}

const buildLanguageModelImageParts = async (
  imageFileNames: string[],
): Promise<ImagePromptPart[]> => {
  const loadStats = { success: 0, failed: 0, totalBytes: 0 }

  const parts = await Promise.all(
    imageFileNames.map(async (imageName): Promise<ImagePromptPart | null> => {
      const parsed = parseImageFileName(imageName)
      if (!parsed) {
        loadStats.failed++
        return null
      }

      const { docIndex, docId, imageNumber } = parsed
      const imageDir = path.join(IMAGE_BASE_DIR, docId)
      const resolvedPath = path.resolve(imageDir)
      if (!resolvedPath.startsWith(IMAGE_BASE_DIR)) {
        Logger.warn(
          { imageDir, imageName, resolvedPath },
          "Rejecting image path outside base dir",
        )
        loadStats.failed++
        return null
      }

      try {
        const absolutePath = findImageByName(imageDir, imageNumber)
        await fs.promises.access(absolutePath, fs.constants.F_OK)
        const imageBytes = await fs.promises.readFile(absolutePath)

        if (imageBytes.length > MAX_IMAGE_BYTES) {
          Logger.debug(
            {
              absolutePath,
              imageName,
              sizeMb: (imageBytes.length / (1024 * 1024)).toFixed(2),
            },
            "Skipping oversized image",
          )
          loadStats.failed++
          return null
        }

        const extension = path.extname(absolutePath).toLowerCase()
        const mediaType = MIME_TYPE_MAP[extension]
        if (!mediaType) {
          Logger.debug(
            { absolutePath, extension, imageName },
            "Unsupported image format for prompt attachment",
          )
          loadStats.failed++
          return null
        }

        loadStats.success++
        loadStats.totalBytes += imageBytes.length

        return {
          label: `Image reference [${docIndex}_${imageNumber}] from document ${docId}.`,
          filePart: {
            type: "file",
            filename: path.basename(absolutePath),
            data: imageBytes,
            mediaType,
          },
        }
      } catch (error) {
        Logger.debug(
          {
            err: error,
            imageName,
          },
          "Failed to load image for prompt attachment",
        )
        loadStats.failed++
        return null
      }
    }),
  )

  const filtered = parts.filter(
    (part): part is ImagePromptPart => part !== null,
  )

  // console.debug('[IMAGE addition][JAF Provider] Image loading complete:', {
  //   requested: imageFileNames.length,
  //   loaded: loadStats.success,
  //   failed: loadStats.failed,
  //   totalMB: (loadStats.totalBytes / (1024 * 1024)).toFixed(2),
  // })

  return filtered
}

export const makeXyneJAFProvider = <Ctx>(
  _opts: MakeXyneJAFProviderOptions = {},
): JAFModelProvider<Ctx> => {
  return {
    async getCompletion(state, agent, runCfg) {
      const model = runCfg.modelOverride ?? agent.modelConfig?.name
      if (!model) {
        throw new Error(`Model not specified for agent ${agent.name}`)
      }

      const modelConfig = MODEL_CONFIGURATIONS[model as Models]
      const actualModelId = modelConfig?.actualName ?? model

      // Check if this is a LiteLLM model - use OpenAI client directly like JAF does
      const providerType = ModelToProviderMap[model as Models] ?? AIProviders.LiteLLM
      const runContext = state.context as unknown as AgentRunContext
      const stopSignal =
        runContext?.stopSignal ?? runContext?.stopController?.signal

      if (providerType === AIProviders.LiteLLM) {
        // Use OpenAI client directly for LiteLLM (same as JAF's makeLiteLLMProvider)
        const { LiteLLMBaseUrl, LiteLLMApiKey } = config
        if (!LiteLLMBaseUrl) {
          throw new Error(
            "LiteLLM base URL not configured. Cannot route LiteLLM provider calls.",
          )
        }
        if (!LiteLLMApiKey) {
          throw new Error(
            "LiteLLM API key not configured. Cannot route LiteLLM provider calls.",
          )
        }

        const client = new OpenAI({
          baseURL: LiteLLMBaseUrl,
          apiKey: LiteLLMApiKey,
        })

        // Build messages in OpenAI format
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
          []

        // Add system message
        messages.push({
          role: "system",
          content: agent.instructions(state),
        })

        // Convert JAF messages to OpenAI format
        for (const message of state.messages) {
          if (message.role === "user") {
            const text = getTextContent(message.content) || ""
            messages.push({
              role: "user",
              content: text,
            })
          } else if (message.role === "assistant") {
            const text = getTextContent(message.content) || ""
            const toolCalls = message.tool_calls?.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === "string"
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
              },
            }))

            messages.push({
              role: "assistant",
              content: text || null,
              ...(toolCalls && toolCalls.length > 0
                ? { tool_calls: toolCalls }
                : {}),
            })
          } else if (message.role === "tool") {
            const toolCallId = (message as { tool_call_id?: string })
              .tool_call_id
            const content = getTextContent(message.content) || ""
            if (toolCallId) {
              messages.push({
                role: "tool",
                tool_call_id: toolCallId,
                content: content,
              })
            }
          }
        }

        // Build tools in OpenAI format
        const tools = buildFunctionTools(agent).map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as any,
          },
        }))

        const advRun = (
          state.context as {
            advancedConfig?: {
              run?: {
                parallelToolCalls: boolean
                toolChoice: "auto" | "none" | "required" | undefined
              }
            }
          }
        )?.advancedConfig?.run

        // Create completion request
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
          {
            model: actualModelId,
            messages: messages,
            temperature: agent.modelConfig?.temperature,
            max_tokens: agent.modelConfig?.maxTokens,
            ...(tools.length > 0 ? { tools } : {}),
            ...(tools.length > 0 && advRun?.toolChoice
              ? { tool_choice: advRun.toolChoice }
              : {}),
            ...(tools.length > 0 && advRun?.parallelToolCalls !== undefined
              ? { parallel_tool_calls: advRun.parallelToolCalls }
              : {}),
          }

        if (agent.outputCodec) {
          params.response_format = { type: "json_object" }
        }

        throwIfStopRequested(stopSignal)
        const resp = await raceWithStop(
          client.chat.completions.create(params),
          stopSignal,
        )

        // Return in JAF format (same as JAF's makeLiteLLMProvider)
        const choice = resp.choices[0]
        const message = choice?.message

        const toolCalls = message?.tool_calls
          ?.filter((tc) => tc.type === "function" && "function" in tc)
          ?.map((tc) => {
            const toolCall = tc as Extract<
              typeof tc,
              { type: "function"; function: any }
            >
            return {
              id: toolCall.id || "",
              type: "function" as const,
              function: {
                name: toolCall.function.name || "",
                arguments:
                  typeof toolCall.function.arguments === "string"
                    ? toolCall.function.arguments
                    : JSON.stringify(toolCall.function.arguments || {}),
              },
            }
          })

        return {
          message: {
            content: message?.content || null,
            ...(toolCalls && toolCalls.length > 0
              ? { tool_calls: toolCalls }
              : {}),
          },
        }
      }

      // For other providers, use AI SDK as before
      const provider = getAISDKProviderByModel(model as Models)
      const languageModel = provider.languageModel(actualModelId)
      const pendingReview = runContext?.review?.pendingReview
      const userEmail = runContext?.user?.email || "unknown"
      const turnNumber = normalizeTurnNumber(runContext?.turnCount)
      const providerLogger = loggerWithChild({ email: userEmail })
      if (pendingReview) {
        try {
          await pendingReview
        } catch (error) {
          Logger.warn(
            {
              email: runContext?.user?.email,
              turn: normalizeTurnNumber(runContext?.turnCount),
              error: error instanceof Error ? error.message : String(error),
            },
            "[JAF Provider] Pending review promise rejected; continuing LLM call",
          )
        }
        throwIfStopRequested(stopSignal)
      }

      const prompt = buildPromptFromMessages(
        state.messages,
        agent.instructions(state),
      )

      // console.debug('[IMAGE addition][JAF Provider] getCompletion called with context:', {
      //   hasContext: !!state.context,
      //   hasImageFileNames: !!(state.context as any)?.imageFileNames,
      //   imageFileNamesLength: ((state.context as any)?.imageFileNames)?.length || 0,
      //   hasImageMetadata: ((state.context as any)?.imageMetadata) instanceof Map,
      //   imageMetadataSize: ((state.context as any)?.imageMetadata) instanceof Map ? ((state.context as any)?.imageMetadata).size : 0,
      //   turnCount: (state.context as any)?.turnCount,
      //   userEmail: ((state.context as any)?.user)?.email,
      //   contextType: typeof state.context,
      //   model,
      //   agentName: agent.name,
      // })
      const selectedImages = getRecentImagesFromContext(runContext)
      Logger.debug(
        {
          email: runContext?.user?.email,
          turn: normalizeTurnNumber(runContext?.turnCount),
          currentTurnImages: runContext?.currentTurnArtifacts?.images?.map(
            (img) => img.fileName,
          ),
          recentWindowImages: runContext?.recentImages?.map(
            (img) => img.fileName,
          ),
          selectedImages,
        },
        "[JAF Provider] Prepared image attachments for agent call",
      )

      if (selectedImages.length > 0) {
        const lastUserIndex = findLastUserMessageIndex(prompt)

        if (lastUserIndex !== -1) {
          const imageParts = await buildLanguageModelImageParts(selectedImages)
          if (imageParts.length > 0) {
            const userMessage = prompt[lastUserIndex]
            if (userMessage?.role === "user") {
              const userContent = userMessage.content
              const contentBefore = userContent.length
              for (const { label, filePart } of imageParts) {
                userContent.push({
                  type: "text",
                  text: label,
                } as LanguageModelV2TextPart)
                userContent.push(filePart)
              }
              // console.debug('[IMAGE addition][JAF Provider] Attached images to prompt:', {
              //   turn: runContext.turnCount ?? MIN_TURN_NUMBER,
              //   messageIndex: lastUserIndex,
              //   imagesAttached: imageParts.length,
              //   contentPartsBefore: contentBefore,
              //   contentPartsAfter: userContent.length,
              //   userEmail: runContext.user?.email,
              // })
            } else {
              providerLogger.warn(
                {
                  messageRole: userMessage?.role ?? "unknown",
                  selectedImagesCount: selectedImages.length,
                  turn: turnNumber,
                },
                "Expected last user index to resolve to a user message",
              )
            }
          } else {
            providerLogger.debug(
              { selectedImagesCount: selectedImages.length, turn: turnNumber },
              "No valid image parts built for selected images",
            )
          }
        } else {
          providerLogger.debug(
            { selectedImagesCount: selectedImages.length, turn: turnNumber },
            "No user message found to attach selected images to",
          )
        }
      }

      const tools = buildFunctionTools(agent)
      const advRun = (
        state.context as {
          advancedConfig?: {
            run?: {
              parallelToolCalls: boolean
              toolChoice: "auto" | "none" | "required" | undefined
            }
          }
        }
      )?.advancedConfig?.run

      const callOptions: LanguageModelV2CallOptions = {
        prompt,
        maxOutputTokens: agent.modelConfig?.maxTokens,
        temperature: agent.modelConfig?.temperature,
        ...(tools.length ? { tools } : {}),
      }

      if (tools.length) {
        callOptions.toolChoice = mapToolChoice(advRun?.toolChoice)
      }

      if (agent.outputCodec) {
        callOptions.responseFormat = {
          type: "json",
          schema: zodSchemaToJsonSchema(agent.outputCodec) as JSONSchema7,
        }
      }

      // Log the complete prompt and call options being sent to the LLM
      Logger.debug(
        {
          email: userEmail,
          turn: turnNumber,
          model: actualModelId,
          agentName: agent.name,
          messagesCount: callOptions.prompt.length,
          toolsCount: tools.length,
          maxOutputTokens: callOptions.maxOutputTokens,
          temperature: callOptions.temperature,
          hasResponseFormat: !!callOptions.responseFormat,
          toolChoice: callOptions.toolChoice,
        },
        "[JAF Provider] LLM call parameters",
      )

      // Sanitize prompt to avoid logging large file data buffers
      const sanitizedPrompt = sanitizePromptForLogging(callOptions.prompt)


      throwIfStopRequested(stopSignal)
      const result = await raceWithStop(
        Promise.resolve(languageModel.doGenerate(callOptions)),
        stopSignal,
      )

      const contentSummary = (result.content || []).map((part, index) => {
        if (part.type === "text") {
          return {
            index,
            type: part.type,
            preview: part.text.slice(0, 160),
          }
        }
        return { index, type: part.type }
      })

      Logger.debug(
        {
          email: userEmail,
          turn: turnNumber,
          model: actualModelId,
          finishReason: result.finishReason,
          usage: result.usage,
          contentSummary,
        },
        "[JAF Provider] Raw LLM response",
      )

      const message = convertResultToJAFMessage(result.content)

      return { message }
    },
  }
}

type SchemaWithRawJson = {
  __xyne_raw_json_schema?: JSONSchema7
}

const mapToolChoice = (
  choice: "auto" | "none" | "required" | undefined,
): LanguageModelV2ToolChoice | undefined => {
  if (!choice) return undefined
  switch (choice) {
    case "auto":
      return { type: "auto" }
    case "none":
      return { type: "none" }
    case "required":
      return { type: "required" }
    default:
      return undefined
  }
}

const buildFunctionTools = <Ctx, Out>(
  agent: Readonly<JAFAgent<Ctx, Out>>,
): LanguageModelV2FunctionTool[] => {
  const ensureObjectSchema = (schema: JSONSchema7 | undefined): JSONSchema7 => {
    if (!schema || typeof schema !== "object") {
      return { type: "object", properties: {} }
    }

    if (schema.type === "object" || schema.properties) {
      return {
        ...schema,
        type: "object",
        properties: schema.properties ?? {},
      }
    }

    return {
      type: "object",
      properties: {
        value: schema,
      },
      required: ["value"],
    }
  }

  return (agent.tools || []).map((tool) => {
    const schemaParameters = tool.schema.parameters as SchemaWithRawJson
    const rawSchema = schemaParameters.__xyne_raw_json_schema

    let inputSchema: JSONSchema7

    if (rawSchema && typeof rawSchema === "object") {
      // Use pre-converted JSON schema if available
      inputSchema = ensureObjectSchema(rawSchema as JSONSchema7)
    } else {
      // Convert Zod schema to JSON schema
      try {
        // Cast the Zod schema to the expected type for conversion
        const zodSchema = tool.schema.parameters as any
        const convertedSchema = zodSchemaToJsonSchema(zodSchema) as JSONSchema7
        inputSchema = ensureObjectSchema(convertedSchema)
      } catch (error) {
        Logger.warn(
          {
            err: error,
            toolName: tool.schema.name,
          },
          "Failed to convert Zod schema to JSON for tool",
        )
        // Fallback to empty object schema
        inputSchema = { type: "object", properties: {} }
      }
    }

    return {
      type: "function" as const,
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema,
    }
  })
}

const buildPromptFromMessages = (
  messages: ReadonlyArray<JAFMessage>,
  systemInstruction: string,
): LanguageModelV2Message[] => {
  const prompt: LanguageModelV2Message[] = []
  const toolNameById = new Map<string, string>()

  prompt.push({ role: "system", content: systemInstruction })

  for (const message of messages) {
    if (message.role === "user") {
      const text = getTextContent(message.content) || ""
      prompt.push({
        role: "user",
        content: [{ type: "text", text }],
      })
      continue
    }

    if (message.role === "assistant") {
      const parts: Array<
        | LanguageModelV2TextPart
        | LanguageModelV2FilePart
        | LanguageModelV2ReasoningPart
        | LanguageModelV2ToolCallPart
        | LanguageModelV2ToolResultPart
      > = []
      const text = getTextContent(message.content)
      if (text) {
        parts.push({ type: "text", text })
      }

      for (const toolCall of message.tool_calls ?? []) {
        toolNameById.set(toolCall.id, toolCall.function.name)

        const rawArgs = toolCall.function.arguments
        let parsedArgs: JSONValue = {}
        if (typeof rawArgs === "string") {
          try {
            const maybeParsed = JSON.parse(rawArgs)
            if (maybeParsed && typeof maybeParsed === "object") {
              parsedArgs = maybeParsed as JSONValue
            }
          } catch {
            // keep default empty object if parsing fails
          }
        } else if (rawArgs && typeof rawArgs === "object") {
          parsedArgs = rawArgs as JSONValue
        }

        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: parsedArgs,
        })
      }

      if (parts.length > 0) {
        prompt.push({
          role: "assistant",
          content: parts,
        })
      }
      continue
    }

    if (message.role === "tool") {
      const toolCallId = (message as { tool_call_id?: string }).tool_call_id
      if (!toolCallId) {
        continue
      }

      const toolName = toolNameById.get(toolCallId) ?? "unknown"
      const output = createToolResultOutput(message)
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            output,
          },
        ],
      })
    }
  }

  return prompt
}

const createToolResultOutput = (
  message: JAFMessage,
): LanguageModelV2ToolResultOutput => {
  const raw = getTextContent(message.content)
  if (!raw) {
    return { type: "text", value: "" }
  }

  const parsed = safeParseJson(raw)
  if (typeof parsed === "string") {
    return { type: "text", value: parsed }
  }

  if (
    parsed === null ||
    typeof parsed === "number" ||
    typeof parsed === "boolean" ||
    Array.isArray(parsed) ||
    typeof parsed === "object"
  ) {
    return { type: "json", value: parsed as JSONValue }
  }

  return { type: "text", value: raw }
}

const convertResultToJAFMessage = (
  content: Array<LanguageModelV2Content>,
): {
  content: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
} => {
  const textSegments = content
    .filter(
      (part): part is Extract<LanguageModelV2Content, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)

  let aggregatedText = textSegments.join("\n")

  if (!aggregatedText) {
    const toolResult = content.find(
      (
        part,
      ): part is Extract<LanguageModelV2Content, { type: "tool-result" }> =>
        part.type === "tool-result",
    )
    if (toolResult) {
      const resultValue = toolResult.result
      aggregatedText =
        typeof resultValue === "string"
          ? resultValue
          : JSON.stringify(resultValue ?? {})
    }
  }

  const toolCalls = content
    .filter(
      (part): part is LanguageModelV2ToolCall => part.type === "tool-call",
    )
    .map((part) => ({
      id: part.toolCallId,
      type: "function" as const,
      function: {
        name: part.toolName,
        arguments:
          typeof part.input === "string"
            ? part.input
            : JSON.stringify(part.input ?? {}),
      },
    }))

  return {
    content: aggregatedText || "",
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  }
}

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Sanitizes prompt messages by removing large file data buffers for logging
 * Replaces file data with metadata about the file instead of the full buffer
 */
const sanitizePromptForLogging = (
  messages: LanguageModelV2Message[],
): any[] => {
  return messages.map((message) => {
    if (!message.content || !Array.isArray(message.content)) {
      return message
    }

    const sanitizedContent = message.content.map((part: any) => {
      if (part.type === "file") {
        const filePart = part as LanguageModelV2FilePart
        const dataSize = Buffer.isBuffer(filePart.data)
          ? filePart.data.length
          : filePart.data instanceof Uint8Array
            ? filePart.data.length
            : 0

        return {
          type: "file",
          filename: filePart.filename,
          mediaType: filePart.mediaType,
          data: `<Buffer [${dataSize} bytes]>`,
        }
      }
      return part
    })

    return {
      ...message,
      content: sanitizedContent,
    }
  })
}
