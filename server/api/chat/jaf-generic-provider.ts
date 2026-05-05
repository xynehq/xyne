import fs from "fs"
import path from "path"
import { ModelToProviderMap } from "@/ai/mappers"
import { MODEL_CONFIGURATIONS } from "@/ai/modelConfig"
import { findImageByName, regex } from "@/ai/provider/base"
import { AIProviders, Models } from "@/ai/types"
import config from "@/config"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import {
  type GenericOpenAIProviderOptions,
  type GenericOpenAIRequestContext,
  type Agent as JAFAgent,
  type Message as JAFMessage,
  type ModelProvider as JAFModelProvider,
  type RunConfig as JAFRunConfig,
  type RunState as JAFRunState,
  type MessageContentPart,
  getTextContent,
  makeGenericOpenAIProvider,
} from "@juspay-xyne-jaf/jaf"
import type { ZodTypeAny } from "zod"
import type { AgentRunContext } from "./agent-schemas"
import { throwIfStopRequested } from "./agent-stop"
import { getImageFileNamesForLlmFromStores } from "./document-memory"
import {
  type MakeXyneJAFProviderOptions,
  makeXyneJAFProvider,
} from "./jaf-provider"
import { zodSchemaToJsonSchema } from "./jaf-provider-utils"

const { IMAGE_CONTEXT_CONFIG } = config
const getImageBaseDir = (): string =>
  path.resolve(process.env.IMAGE_DIR || "downloads/xyne_images_db")
const isImageContextEnabled = (): boolean =>
  process.env.ENABLE_IMAGES !== undefined
    ? process.env.ENABLE_IMAGES === "true"
    : IMAGE_CONTEXT_CONFIG.enabled
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MIME_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const Logger = getLogger(Subsystem.Chat).child({
  module: "jaf-generic-provider",
})
const loggerWithChild = getLoggerWithChild(Subsystem.Chat, {
  module: "jaf-generic-provider",
})
const MIN_TURN_NUMBER = 1
const normalizeTurnNumber = (turn?: number | null): number =>
  typeof turn === "number" && turn >= MIN_TURN_NUMBER ? turn : MIN_TURN_NUMBER

const isPathInside = (basePath: string, targetPath: string): boolean => {
  const relativePath = path.relative(basePath, targetPath)
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
}

export type MakeXyneGenericJAFProviderOptions<Ctx> =
  MakeXyneJAFProviderOptions & {
    legacyProvider?: JAFModelProvider<Ctx>
  }

type ImagePromptPart = {
  label: string
  data: Buffer
  mediaType: string
  filename: string
}

type XyneGenericOpenAIProviderOptions<Ctx> = Omit<
  GenericOpenAIProviderOptions<Ctx>,
  "schemaConverter"
> & {
  readonly schemaConverter?: (schema: ZodTypeAny) => Record<string, unknown>
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

const buildOpenAIImageParts = async (
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
      const imageBaseDir = getImageBaseDir()
      const imageDir = path.join(imageBaseDir, docId)
      const baseResolved = path.resolve(imageBaseDir)
      const resolvedPath = path.resolve(imageDir)
      if (!isPathInside(baseResolved, resolvedPath)) {
        Logger.warn(
          { baseResolved, imageDir, imageName, resolvedPath },
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
          data: imageBytes,
          mediaType,
          filename: path.basename(absolutePath),
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

  return parts.filter((part): part is ImagePromptPart => part !== null)
}

const getStopSignal = (context: unknown): AbortSignal | undefined => {
  const runContext = context as Partial<AgentRunContext> | undefined
  return runContext?.stopSignal ?? runContext?.stopController?.signal
}

const getProviderConnection = (providerType: AIProviders) => {
  if (providerType === AIProviders.OpenAI) {
    const apiKey = process.env.OPENAI_API_KEY || config.OpenAIKey
    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Cannot route generic JAF provider calls.",
      )
    }

    return {
      apiKey,
      baseURL:
        process.env.BASE_URL ||
        config.aiProviderBaseUrl ||
        "https://api.openai.com/v1",
    }
  }

  const baseURL = process.env.LITELLM_BASE_URL || config.LiteLLMBaseUrl
  const apiKey = process.env.LITELLM_API_KEY || config.LiteLLMApiKey

  if (!baseURL) {
    throw new Error(
      "LiteLLM base URL not configured. Cannot route generic JAF provider calls.",
    )
  }
  if (!apiKey) {
    throw new Error(
      "LiteLLM API key not configured. Cannot route generic JAF provider calls.",
    )
  }

  return {
    apiKey,
    baseURL,
  }
}

const isGenericCompatibleProvider = (providerType: AIProviders): boolean =>
  providerType === AIProviders.LiteLLM || providerType === AIProviders.OpenAI

const attachImagesToLastUserMessage = async <Ctx>(
  state: Readonly<JAFRunState<Ctx>>,
): Promise<Readonly<JAFRunState<Ctx>>> => {
  const runContext = state.context as unknown as AgentRunContext | undefined
  const imageBudget =
    IMAGE_CONTEXT_CONFIG.maxImagesPerCall !== undefined &&
    IMAGE_CONTEXT_CONFIG.maxImagesPerCall >= 0
      ? IMAGE_CONTEXT_CONFIG.maxImagesPerCall
      : 5

  const { imageFileNamesForModel: selectedImages } =
    isImageContextEnabled() && runContext?.imageMemory
      ? getImageFileNamesForLlmFromStores(runContext.imageMemory, {
          maxImages: imageBudget,
        })
      : { imageFileNamesForModel: [] }

  if (selectedImages.length === 0) {
    return state
  }

  let lastUserIndex = -1
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i]?.role === "user") {
      lastUserIndex = i
      break
    }
  }

  if (lastUserIndex === -1) {
    return state
  }

  const imageParts = await buildOpenAIImageParts(selectedImages)
  if (imageParts.length === 0) {
    loggerWithChild({ email: runContext?.user?.email || "unknown" }).warn(
      {
        selectedImagesCount: selectedImages.length,
        turn: normalizeTurnNumber(runContext?.turnCount),
        imageBaseDir: getImageBaseDir(),
        firstSelectedImageRedacted: true,
      },
      "No valid image parts built for selected images (generic provider path)",
    )
    return state
  }

  const messages = state.messages.map((message, index): JAFMessage => {
    if (index !== lastUserIndex || message.role !== "user") {
      return message
    }

    const contentParts: MessageContentPart[] = Array.isArray(message.content)
      ? [...message.content]
      : getTextContent(message.content)
        ? [{ type: "text", text: getTextContent(message.content) }]
        : []

    for (const imagePart of imageParts) {
      contentParts.push({ type: "text", text: imagePart.label })
      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:${imagePart.mediaType};base64,${imagePart.data.toString(
            "base64",
          )}`,
        },
      })
    }

    return {
      ...message,
      content: contentParts,
    }
  })

  return {
    ...state,
    messages,
  }
}

const addXyneRequestOptions = <Ctx>(
  body: Record<string, unknown>,
  state: Readonly<JAFRunState<Ctx>>,
): Record<string, unknown> => {
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

  const tools = body.tools
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (!hasTools) {
    return body
  }

  if (advRun?.toolChoice) {
    body.tool_choice = advRun.toolChoice
  }
  if (advRun?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = advRun.parallelToolCalls
  }

  return body
}

export const makeXyneGenericJAFProvider = <Ctx>(
  opts: MakeXyneGenericJAFProviderOptions<Ctx> = {},
): JAFModelProvider<Ctx> => {
  const { legacyProvider, ...legacyOptions } = opts
  const legacy = legacyProvider ?? makeXyneJAFProvider<Ctx>(legacyOptions)

  return {
    async getCompletion(state, agent, runCfg) {
      const requestedModel = runCfg.modelOverride ?? agent.modelConfig?.name
      if (!requestedModel) {
        throw new Error(`Model not specified for agent ${agent.name}`)
      }

      const providerType = (
        ModelToProviderMap as Partial<Record<Models, AIProviders>>
      )[requestedModel as Models]
      if (!providerType) {
        Logger.warn(
          { agentName: agent.name, requestedModel },
          "Unknown requested model; falling back to legacy provider",
        )
        return legacy.getCompletion(state, agent, runCfg)
      }

      if (!isGenericCompatibleProvider(providerType)) {
        return legacy.getCompletion(state, agent, runCfg)
      }

      const runContext = state.context as unknown as AgentRunContext | undefined
      const stopSignal = getStopSignal(runContext)
      throwIfStopRequested(stopSignal)

      const modelConfig = MODEL_CONFIGURATIONS[requestedModel as Models]
      const actualModelId = modelConfig?.actualName ?? requestedModel
      const { apiKey, baseURL } = getProviderConnection(providerType)
      const genericOptions: XyneGenericOpenAIProviderOptions<Ctx> = {
        baseURL,
        schemaConverter: (schema: ZodTypeAny): Record<string, unknown> =>
          zodSchemaToJsonSchema(schema) as Record<string, unknown>,
        getAbortSignal: (providerState: Readonly<JAFRunState<Ctx>>) =>
          getStopSignal(providerState.context),
        customizeRequestBody: (
          body: Record<string, unknown>,
          context: GenericOpenAIRequestContext<Ctx>,
        ) => addXyneRequestOptions(body, context.state),
      }
      const genericProvider = makeGenericOpenAIProvider<Ctx>(
        apiKey,
        genericOptions as GenericOpenAIProviderOptions<Ctx>,
      )

      const stateWithImages = await attachImagesToLastUserMessage(state)
      throwIfStopRequested(stopSignal)

      const genericAgent: JAFAgent<Ctx, any> = {
        ...agent,
        modelConfig: {
          ...agent.modelConfig,
          name: actualModelId,
        },
      }
      const genericRunCfg: JAFRunConfig<Ctx> = {
        ...runCfg,
        modelProvider: genericProvider,
        modelOverride: actualModelId,
      }

      return genericProvider.getCompletion(
        stateWithImages,
        genericAgent,
        genericRunCfg,
      )
    },
  }
}
