import { getAISDKProviderByModel } from "@/ai/provider"
import { MODEL_CONFIGURATIONS } from "@/ai/modelConfig"
import config from "@/config"
import type {
  ModelProvider as JAFModelProvider,
  Message as JAFMessage,
  Agent as JAFAgent,
} from "@xynehq/jaf"
import { getTextContent } from "@xynehq/jaf"
import { Models } from "@/ai/types"
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolChoice,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2TextPart,
  LanguageModelV2FilePart,
  LanguageModelV2ReasoningPart,
  LanguageModelV2ToolCallPart,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider"
import { zodSchemaToJsonSchema } from "./jaf-provider-utils"
import path from "path"
import fs from "fs"
import { regex, findImageByName } from "@/ai/provider/base"
import type { AgentImageMetadata } from "./agent-schemas"
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

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

type ImageAwareContext = {
  imageFileNames?: string[]
  imageMetadata?: Map<string, AgentImageMetadata>
  turnCount?: number
  user?: { email?: string }
}

type ImagePromptPart = {
  label: string
  filePart: LanguageModelV2FilePart
}

const selectImagesForCall = (context: ImageAwareContext): string[] => {
  console.info('[IMAGE addition][JAF Provider] selectImagesForCall called:', {
    enabled: IMAGE_CONTEXT_CONFIG.enabled,
    imageCount: context?.imageFileNames?.length || 0,
    hasImageFileNames: !!context?.imageFileNames,
    hasMetadata: context?.imageMetadata instanceof Map,
    metadataSize: context?.imageMetadata instanceof Map ? context.imageMetadata.size : 0,
    turnCount: context?.turnCount,
    userEmail: context?.user?.email,
    contextKeys: context ? Object.keys(context) : [],
  })

  if (
    !IMAGE_CONTEXT_CONFIG.enabled ||
    !context?.imageFileNames?.length ||
    !(context.imageMetadata instanceof Map)
  ) {
    console.info('[IMAGE addition][JAF Provider] Image selection skipped:', {
      reason: !IMAGE_CONTEXT_CONFIG.enabled ? 'disabled' : 
              !context?.imageFileNames?.length ? 'no_images' : 
              !(context.imageMetadata instanceof Map) ? 'no_metadata' : 'unknown',
      enabled: IMAGE_CONTEXT_CONFIG.enabled,
      imageCount: context?.imageFileNames?.length || 0,
      hasMetadata: context?.imageMetadata instanceof Map,
      userEmail: context?.user?.email,
    })
    return []
  }

  const currentTurn = context.turnCount ?? 0
  const attachments: string[] = []
  const recentImages: string[] = []
  const skipped: Array<{ name: string; age: number; reason: string }> = []

  for (const imageName of context.imageFileNames) {
    const metadata = context.imageMetadata.get(imageName)
    if (!metadata) {
      skipped.push({ name: imageName, age: -1, reason: 'no_metadata' })
      continue
    }

    if (metadata.isUserAttachment && IMAGE_CONTEXT_CONFIG.alwaysIncludeAttachments) {
      attachments.push(imageName)
      continue
    }

    const age = currentTurn - metadata.addedAtTurn
    if (age <= IMAGE_CONTEXT_CONFIG.recencyWindow) {
      recentImages.push(imageName)
    } else {
      skipped.push({ name: imageName, age, reason: 'too_old' })
    }
  }

  const combined = [...attachments, ...recentImages]
  const finalSelection = IMAGE_CONTEXT_CONFIG.maxImagesPerCall > 0 &&
    combined.length > IMAGE_CONTEXT_CONFIG.maxImagesPerCall
    ? combined.slice(0, IMAGE_CONTEXT_CONFIG.maxImagesPerCall)
    : combined // Pass all images when maxImagesPerCall is 0 (no limit)

  console.info('[IMAGE addition][JAF Provider] Image selection turn', currentTurn, {
    totalPool: context.imageFileNames.length,
    attachments: attachments.length,
    recent: recentImages.length,
    skipped: skipped.length,
    selected: finalSelection.length,
    recencyWindow: IMAGE_CONTEXT_CONFIG.recencyWindow,
    userEmail: context.user?.email,
  })

  return finalSelection
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
    console.warn(`[JAF Provider] Invalid image reference: ${imageName}`)
    return null
  }
  const [, docIndex, docId, imageNumber] = match
  if (docId.includes("..") || docId.includes("/") || docId.includes("\\")) {
    console.warn(`[JAF Provider] Suspicious docId detected: ${docId}`)
    return null
  }
  return { docIndex, docId, imageNumber }
}

const buildLanguageModelImageParts = async (
  imageFileNames: string[],
): Promise<ImagePromptPart[]> => {
  const loadStats = { success: 0, failed: 0, totalBytes: 0 }
  
  const parts = await Promise.all(
    imageFileNames.map(async (imageName) => {
      const parsed = parseImageFileName(imageName)
      if (!parsed) {
        loadStats.failed++
        return null
      }

      const { docIndex, docId, imageNumber } = parsed
      const imageDir = path.join(IMAGE_BASE_DIR, docId)
      const resolvedPath = path.resolve(imageDir)
      if (!resolvedPath.startsWith(IMAGE_BASE_DIR)) {
        console.warn(
          `[JAF Provider] Rejecting image path outside base dir: ${imageDir}`,
        )
        loadStats.failed++
        return null
      }

      try {
        const absolutePath = findImageByName(imageDir, imageNumber)
        await fs.promises.access(absolutePath, fs.constants.F_OK)
        const imageBytes = await fs.promises.readFile(absolutePath)

        if (imageBytes.length > MAX_IMAGE_BYTES) {
          console.warn(
            `[JAF Provider] Skipping image ${absolutePath} due to size ${(imageBytes.length / (1024 * 1024)).toFixed(2)}MB`,
          )
          loadStats.failed++
          return null
        }

        const extension = path.extname(absolutePath).toLowerCase()
        const mediaType = MIME_TYPE_MAP[extension]
        if (!mediaType) {
          console.warn(
            `[JAF Provider] Unsupported image format ${extension} for ${absolutePath}`,
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
        console.warn(
          `[JAF Provider] Failed to load image ${imageName}: ${
            error instanceof Error ? error.message : error
          }`,
        )
        loadStats.failed++
        return null
      }
    }),
  )

  const filtered = parts.filter((part): part is ImagePromptPart => Boolean(part))
  
  console.info('[IMAGE addition][JAF Provider] Image loading complete:', {
    requested: imageFileNames.length,
    loaded: loadStats.success,
    failed: loadStats.failed,
    totalMB: (loadStats.totalBytes / (1024 * 1024)).toFixed(2),
  })
  
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

      const provider = getAISDKProviderByModel(model as Models)
      const modelConfig = MODEL_CONFIGURATIONS[model as Models]
      const actualModelId = modelConfig?.actualName ?? model
      const languageModel = provider.languageModel(actualModelId)

      const prompt = buildPromptFromMessages(
        state.messages,
        agent.instructions(state),
      )

      const imageAwareContext = state.context as ImageAwareContext
      console.info('[IMAGE addition][JAF Provider] getCompletion called with context:', {
        hasContext: !!state.context,
        hasImageFileNames: !!(state.context as any)?.imageFileNames,
        imageFileNamesLength: ((state.context as any)?.imageFileNames)?.length || 0,
        hasImageMetadata: ((state.context as any)?.imageMetadata) instanceof Map,
        imageMetadataSize: ((state.context as any)?.imageMetadata) instanceof Map ? ((state.context as any)?.imageMetadata).size : 0,
        turnCount: (state.context as any)?.turnCount,
        userEmail: ((state.context as any)?.user)?.email,
        contextType: typeof state.context,
        model,
        agentName: agent.name,
      })
      const selectedImages = selectImagesForCall(imageAwareContext)
      
      if (selectedImages.length > 0) {
        const lastUserIndex = findLastUserMessageIndex(prompt)
        
        if (lastUserIndex !== -1) {
          const imageParts = await buildLanguageModelImageParts(selectedImages)
          if (imageParts.length > 0) {
            const contentBefore = prompt[lastUserIndex].content.length
            for (const { label, filePart } of imageParts) {
              prompt[lastUserIndex].content.push(
                { type: "text", text: label },
                filePart,
              )
            }
            console.info('[IMAGE addition][JAF Provider] Attached images to prompt:', {
              turn: imageAwareContext.turnCount ?? 0,
              messageIndex: lastUserIndex,
              imagesAttached: imageParts.length,
              contentPartsBefore: contentBefore,
              contentPartsAfter: prompt[lastUserIndex].content.length,
              userEmail: imageAwareContext.user?.email,
            })
          } else {
            console.warn('[JAF Provider] No valid image parts built despite', selectedImages.length, 'selected')
          }
        } else {
          console.warn('[JAF Provider] No user message found to attach', selectedImages.length, 'images to')
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

      const result = await languageModel.doGenerate(callOptions)

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
        console.warn(
          `Failed to convert Zod schema to JSON for tool ${tool.schema.name}:`,
          error,
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
