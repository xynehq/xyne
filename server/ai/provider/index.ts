import llama3Tokenizer from "llama3-tokenizer-js"
import {
  BedrockRuntimeClient,
  ConversationRole,
  type Message,
} from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
import { z } from "zod"

const {
  AwsAccessKey,
  AwsSecretKey,
  OllamaModel,
  OpenAIKey,
  TogetherApiKey,
  FireworksAIModel,
  FireworksApiKey,
  TogetherAIModel,
  defaultBestModel,
  defaultFastModel,
  isReasoning,
  EndThinkingToken,
  GeminiAIModel,
  GeminiApiKey,
  aiProviderBaseUrl,
  VertexProjectId,
  VertexRegion,
  VertexAIModel,
} = config
import OpenAI from "openai"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { parse } from "partial-json"

import { ModelToProviderMap } from "@/ai/mappers"
import type {
  AnswerResponse,
  ChainBreakClassifications,
  ConverseResponse,
  Cost,
  MailParticipant,
  LLMProvider,
  ModelParams,
  QueryRouterLLMResponse,
  QueryRouterResponse,
  TemporalClassifier,
} from "@/ai/types"
import {
  QueryContextRank,
  QueryAnalysisSchema,
  QueryRouterResponseSchema,
  Models,
  AIProviders,
} from "@/ai/types"
import {
  analyzeInitialResultsOrRewriteSystemPrompt,
  analyzeInitialResultsOrRewriteV2SystemPrompt,
  AnalyzeUserQuerySystemPrompt,
  askQuestionUserPrompt,
  baselineFilesContextPromptJson,
  baselinePrompt,
  baselinePromptJson,
  baselineReasoningPromptJson,
  chatWithCitationsSystemPrompt,
  emailPromptJson,
  fallbackReasoningGenerationPrompt,
  generateMarkdownTableSystemPrompt,
  generateTitleSystemPrompt,
  promptGenerationSystemPrompt,
  meetingPromptJson,
  metadataAnalysisSystemPrompt,
  optimizedPrompt,
  peopleQueryAnalysisSystemPrompt,
  queryRewritePromptJson,
  rewriteQuerySystemPrompt,
  searchQueryPrompt,
  searchQueryReasoningPrompt,
  SearchQueryToolContextPrompt,
  synthesisContextPrompt,
  temporalDirectionJsonPrompt,
  userChatSystem,
  withToolQueryPrompt,
  ragOffPromptJson,
  nameToEmailResolutionPrompt,
  deepResearchPrompt,
  webSearchSystemPrompt,
  agentWithNoIntegrationsSystemPrompt,
  extractBestDocumentsPrompt,
} from "@/ai/prompts"

import { BedrockProvider } from "@/ai/provider/bedrock"
import { OpenAIProvider } from "@/ai/provider/openai"
import { Ollama } from "ollama"
import { OllamaProvider } from "@/ai/provider/ollama"
import Together from "together-ai"
import { TogetherProvider } from "@/ai/provider/together"
import { Fireworks } from "@/ai/provider/fireworksClient"
import { FireworksProvider } from "@/ai/provider/fireworks"
import { GoogleGenAI } from "@google/genai"
import { GeminiAIProvider } from "@/ai/provider/gemini"
import { VertexAiProvider, VertexProvider } from "@/ai/provider/vertex_ai"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createOpenAI } from "@ai-sdk/openai"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import type { ProviderV2 } from "@ai-sdk/provider"
import {
  agentAnalyzeInitialResultsOrRewriteSystemPrompt,
  agentAnalyzeInitialResultsOrRewriteV2SystemPrompt,
  agentBaselineFilesContextPromptJson,
  agentBaselineKbContextPromptJson,
  agentBaselinePrompt,
  agentBaselinePromptJson,
  agentBaselineReasoningPromptJson,
  agentEmailPromptJson,
  agentGenerateMarkdownTableSystemPrompt,
  agentOptimizedPrompt,
  agentQueryRewritePromptJson,
  agentSearchQueryPrompt,
  agentTemporalDirectionJsonPrompt,
} from "../agentPrompts"
import { is } from "drizzle-orm"
import type { ToolDefinition } from "@/api/chat/mapper"
import { getDateForAI } from "@/utils/index"

const Logger = getLogger(Subsystem.AI)

export interface AgentPromptData {
  name: string
  description: string
  prompt: string
  sources: any[]
}

interface ParsedPromptCandidate {
  name?: unknown
  description?: unknown
  prompt?: unknown
  appIntegrations?: unknown
  sources?: unknown
}

function parseAgentPrompt(
  agentPromptString: string | undefined,
): AgentPromptData {
  const defaults: AgentPromptData = {
    name: "",
    description: "",
    prompt: "",
    sources: [],
  }

  if (!agentPromptString) {
    return defaults
  }

  try {
    const parsed = JSON.parse(agentPromptString) as ParsedPromptCandidate

    if (
      typeof parsed.name === "string" &&
      typeof parsed.description === "string" &&
      typeof parsed.prompt === "string"
    ) {
      return {
        name: parsed.name,
        description: parsed.description,
        prompt: parsed.prompt,
        sources: parsed.appIntegrations as any[],
      }
    }

    if (typeof parsed.prompt === "string" && Array.isArray(parsed.sources)) {
      return {
        ...defaults,
        prompt: parsed.prompt,
        sources: parsed.sources,
      }
    }

    Logger.warn(
      `Agent prompt string is valid JSON but did not match expected structures. Treating as literal prompt: '${agentPromptString}'`,
    )
    return { ...defaults, prompt: agentPromptString }
  } catch (error) {
    Logger.info(`Agent prompt string is not valid JSON or is empty.`)
    return { ...defaults }
  }
}

function isAgentPromptEmpty(agentPromptString: string | undefined): boolean {
  const { prompt, sources } = parseAgentPrompt(agentPromptString)
  return prompt === "" && Array.isArray(sources) && sources.length === 0
}

const askQuestionSystemPrompt =
  "You are a knowledgeable assistant that provides accurate and up-to-date answers based on the given context."

type TokenCount = number
export const askQuestionInputTokenCount = (
  query: string,
  context: string,
): TokenCount => {
  return llama3Tokenizer.encode(
    "user" + askQuestionSystemPrompt + askQuestionUserPrompt(query, context),
  ).length
}

let providersInitialized = false
let bedrockProvider: LLMProvider | null = null
let openaiProvider: LLMProvider | null = null
let ollamaProvider: LLMProvider | null = null
let togetherProvider: LLMProvider | null = null
let fireworksProvider: LLMProvider | null = null
let geminiProvider: LLMProvider | null = null
let vertexProvider: LLMProvider | null = null
let bedrockAISDKProvider: ProviderV2 | null = null
let openaiAISDKProvider: ProviderV2 | null = null

const initializeProviders = (): void => {
  if (providersInitialized) return

  if (AwsAccessKey && AwsSecretKey) {
    const AwsRegion = process.env["AWS_REGION"] || "us-west-2"
    if (!process.env["AWS_REGION"]) {
      Logger.info(
        "AWS_REGION not provided, falling back to default 'us-west-2'",
      )
    }
    const BedrockClient = new BedrockRuntimeClient({
      region: AwsRegion,
      retryMode: "adaptive",
      maxAttempts: 5,
      credentials: {
        accessKeyId: AwsAccessKey,
        secretAccessKey: AwsSecretKey,
      },
    })
    bedrockProvider = new BedrockProvider(BedrockClient)
  }

  if (OpenAIKey) {
    let openAIClient: OpenAI
    openAIClient = new OpenAI({
      apiKey: OpenAIKey,
      ...(aiProviderBaseUrl ? { baseURL: aiProviderBaseUrl } : {}),
    })
    if (aiProviderBaseUrl) {
      Logger.info(`Found base_url and OpenAI key, using base_url for LLM`)
    }

    openaiProvider = new OpenAIProvider(openAIClient)
  }

  if (OllamaModel) {
    const ollama = new Ollama({
      ...(aiProviderBaseUrl ? { host: aiProviderBaseUrl } : {}),
    })
    if (aiProviderBaseUrl) {
      Logger.info(`Found base_url and Ollama model, using base_url for LLM`)
    }
    ollamaProvider = new OllamaProvider(ollama)
  }

  if (TogetherAIModel && TogetherApiKey) {
    let together: Together
    together = new Together({
      apiKey: TogetherApiKey,
      timeout: 4 * 60 * 1000,
      maxRetries: 10,
      ...(aiProviderBaseUrl ? { baseURL: aiProviderBaseUrl } : {}),
    })
    if (aiProviderBaseUrl) {
      Logger.info(`Found base_url and together key, using base_url for LLM`)
    }

    togetherProvider = new TogetherProvider(together)
  }

  if (FireworksAIModel && FireworksApiKey) {
    const fireworks = new Fireworks({
      apiKey: FireworksApiKey,
    })
    fireworksProvider = new FireworksProvider(fireworks)
  }

  if (GeminiAIModel && GeminiApiKey) {
    const gemini = new GoogleGenAI({ apiKey: GeminiApiKey })
    geminiProvider = new GeminiAIProvider(gemini)
  }

  if (VertexProjectId && VertexRegion) {
    const vertexProviderType = process.env[
      "VERTEX_PROVIDER"
    ] as keyof typeof VertexProvider
    const provider =
      vertexProviderType && VertexProvider[vertexProviderType]
        ? VertexProvider[vertexProviderType]
        : VertexProvider.ANTHROPIC

    vertexProvider = new VertexAiProvider({
      projectId: VertexProjectId,
      region: VertexRegion,
      provider: provider,
    })

    Logger.info(`Initialized VertexAI provider with ${provider} backend`)
  }

  if (!OpenAIKey && !TogetherApiKey && aiProviderBaseUrl) {
    Logger.warn(
      `Not using base_url: base_url is defined, but neither OpenAI nor Together API key was provided.`,
    )
  }
  providersInitialized = true
}

const getProviders = (): {
  [AIProviders.AwsBedrock]: LLMProvider | null
  [AIProviders.OpenAI]: LLMProvider | null
  [AIProviders.Ollama]: LLMProvider | null
  [AIProviders.Together]: LLMProvider | null
  [AIProviders.Fireworks]: LLMProvider | null
  [AIProviders.GoogleAI]: LLMProvider | null
  [AIProviders.VertexAI]: LLMProvider | null
} => {
  initializeProviders()
  if (
    !bedrockProvider &&
    !openaiProvider &&
    !ollamaProvider &&
    !togetherProvider &&
    !fireworksProvider &&
    !geminiProvider &&
    !vertexProvider
  ) {
    throw new Error("No valid API keys or model provided")
  }

  return {
    [AIProviders.AwsBedrock]: bedrockProvider,
    [AIProviders.OpenAI]: openaiProvider,
    [AIProviders.Ollama]: ollamaProvider,
    [AIProviders.Together]: togetherProvider,
    [AIProviders.Fireworks]: fireworksProvider,
    [AIProviders.GoogleAI]: geminiProvider,
    [AIProviders.VertexAI]: vertexProvider,
  }
}

const getProviderMap = (): Partial<Record<AIProviders, LLMProvider>> => {
  const providerMap: Partial<Record<AIProviders, LLMProvider>> = {}
  try {
    const providers = getProviders()
    for (const [key, provider] of Object.entries(providers)) {
      if (provider) {
        providerMap[key as AIProviders] = provider
      }
    }
  } catch (error) {
    Logger.error(error, "AI Provider Error")
    throw error
  }

  return providerMap
}

export const getProviderByModel = (modelId: Models): LLMProvider => {
  const ProviderMap = getProviderMap()

  const providerType = ModelToProviderMap[modelId]
    ? ModelToProviderMap[modelId]
    : OllamaModel
      ? AIProviders.Ollama
      : TogetherAIModel
        ? AIProviders.Together
        : FireworksAIModel
          ? AIProviders.Fireworks
          : GeminiAIModel
            ? AIProviders.GoogleAI
            : VertexProjectId && VertexRegion
              ? AIProviders.VertexAI
              : null

  if (!providerType) {
    throw new Error("Invalid provider type")
  }

  // Special handling for Vertex AI models - create appropriate provider based on model type
  if (
    providerType === AIProviders.VertexAI &&
    VertexProjectId &&
    VertexRegion
  ) {
    const isGeminiModel = modelId.toString().toLowerCase().includes("gemini")
    const requiredProvider = isGeminiModel
      ? VertexProvider.GOOGLE
      : VertexProvider.ANTHROPIC

    // Create a new provider instance with the correct backend for this model
    const vertexProvider = new VertexAiProvider({
      projectId: VertexProjectId,
      region: VertexRegion,
      provider: requiredProvider,
    })

    Logger.info(
      `Created VertexAI provider for model ${modelId} with ${requiredProvider} backend`,
    )
    return vertexProvider
  }

  const provider = ProviderMap[providerType]
  if (!provider) {
    throw new Error("Invalid provider")
  }
  return provider
}

export const getAISDKProviderByModel = (modelId: Models): ProviderV2 => {
  const providerType = ModelToProviderMap[modelId]
    ? ModelToProviderMap[modelId]
    : OllamaModel
      ? AIProviders.Ollama
      : TogetherAIModel
        ? AIProviders.Together
        : FireworksAIModel
          ? AIProviders.Fireworks
          : GeminiAIModel
            ? AIProviders.GoogleAI
            : VertexProjectId && VertexRegion
              ? AIProviders.VertexAI
              : null
  switch (providerType) {
    case AIProviders.VertexAI: {
      if (!VertexProjectId || !VertexRegion) {
        throw new Error("Vertex AI project or region not configured")
      }

      const isGeminiModel = modelId.toString().toLowerCase().includes("gemini")

      const baseConfig = {
        project: VertexProjectId,
        location: VertexRegion,
      }

      if (isGeminiModel) {
        Logger.info(
          `Created Vertex AI SDK provider for model ${modelId} using Google backend`,
        )
        return createVertex(baseConfig)
      }

      Logger.info(
        `Created Vertex AI SDK provider for model ${modelId} using Anthropic backend`,
      )
      return createVertexAnthropic(baseConfig)
    }

    case AIProviders.OpenAI: {
      if (!openaiAISDKProvider) {
        const openAIConfig: Parameters<typeof createOpenAI>[0] = {}

        if (OpenAIKey) {
          openAIConfig.apiKey = OpenAIKey
        }

        if (aiProviderBaseUrl) {
          openAIConfig.baseURL = aiProviderBaseUrl
        }

        Logger.info(
          `Initialized OpenAI AI SDK provider for model ${modelId} using base URL ${openAIConfig.baseURL ?? "https://api.openai.com/v1"}`,
        )

        openaiAISDKProvider = Object.keys(openAIConfig).length
          ? createOpenAI(openAIConfig)
          : createOpenAI()
      }

      if (!openaiAISDKProvider) {
        throw new Error("Failed to initialize OpenAI AI SDK provider")
      }

      return openaiAISDKProvider
    }

    case AIProviders.AwsBedrock: {
      if (!bedrockAISDKProvider) {
        const region = process.env["AWS_REGION"] || "us-west-2"
        const sessionToken = process.env["AWS_SESSION_TOKEN"]

        const bedrockConfig: Parameters<typeof createAmazonBedrock>[0] = {
          region,
        }

        if (AwsAccessKey) {
          bedrockConfig.accessKeyId = AwsAccessKey
        }

        if (AwsSecretKey) {
          bedrockConfig.secretAccessKey = AwsSecretKey
        }

        if (sessionToken) {
          bedrockConfig.sessionToken = sessionToken
        }

        Logger.info(
          `Initialized Amazon Bedrock AI SDK provider for model ${modelId} in region ${region}`,
        )
        bedrockAISDKProvider = createAmazonBedrock(bedrockConfig)
      }

      if (!bedrockAISDKProvider) {
        throw new Error("Failed to initialize Amazon Bedrock AI SDK provider")
      }

      return bedrockAISDKProvider
    }

    default:
      throw new Error(
        `AI SDK provider not available for provider type: ${providerType ?? "unknown"}`,
      )
  }
}

export const askQuestion = (
  query: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = askQuestionSystemPrompt
    }
    return getProviderByModel(params.modelId).converseStream(
      [
        {
          role: "user",
          content: [
            {
              text: askQuestionUserPrompt(query, context, params.userCtx),
            },
          ],
        },
      ],
      params,
    )
  } catch (error) {
    Logger.error(error, "Error asking question")
    throw error
  }
}

export const analyzeQuery = async (
  userQuery: string,
  context: string,
  params: ModelParams,
): Promise<[QueryContextRank, number]> => {
  try {
    const systemPrompt = AnalyzeUserQuerySystemPrompt
    if (!params.systemPrompt) {
      params.systemPrompt = systemPrompt
    }

    if (!params.modelId) {
      params.modelId = defaultFastModel
    }

    const { text: fullResponse, cost } = await getProviderByModel(
      params.modelId,
    ).converse(
      [
        {
          role: "user",
          content: [
            {
              text: `User Query: "${userQuery}"\n\nRetrieved Contexts:\n${context}`,
            },
          ],
        },
      ],
      params,
    )

    if (!fullResponse) {
      throw new Error("Invalid response")
    }

    const structuredResponse = jsonParseLLMOutput(fullResponse)

    return [QueryContextRank.parse(structuredResponse), cost!]
  } catch (error) {
    Logger.error(error, "Error analyzing query")
    throw error
  }
}

export const analyzeQueryMetadata = async (
  userQuery: string,
  context: string,
  params: ModelParams,
): Promise<[QueryContextRank | null, number]> => {
  try {
    let systemPrompt = metadataAnalysisSystemPrompt
    if (!params.systemPrompt) {
      params.systemPrompt = systemPrompt
    }

    let prompt = `User Query: "${userQuery}"\n\nRetrieved metadata Contexts:\n${context}`
    if (!params.prompt) {
      params.prompt = prompt
    }

    const { text, cost } = await getProviderByModel(params.modelId).converse(
      [
        {
          role: "user",
          content: [
            {
              text: askQuestionUserPrompt(userQuery, context, params.userCtx),
            },
          ],
        },
      ],
      params,
    )
    if (!text) {
      throw new Error("Invalid text")
    }
    const structuredResponse = jsonParseLLMOutput(text)

    return [QueryContextRank.parse(structuredResponse), cost!]
  } catch (error) {
    Logger.error(error, "Error analyzing query metadata")
    throw error
  }
}

const nullCloseBraceRegex = /null\s*\n\s*\}/
export const jsonParseLLMOutput = (text: string, jsonKey?: string): any => {
  let jsonVal
  try {
    text = text.trim()
    if (!jsonKey && text.includes("```json")) {
      const jsonCodeBlockMatch = text.match(/```(?:json\s*)?\n?([\s\S]*?)```/)
      if (jsonCodeBlockMatch) {
        text = jsonCodeBlockMatch[1].trim()
      }
    }

    if (
      text.indexOf("{") === -1 &&
      nullCloseBraceRegex.test(text) &&
      !jsonKey
    ) {
      text = text.replaceAll(/[\n"}:`]/g, "")
    }
    if (jsonKey && !text.startsWith("{") && text.includes(jsonKey)) {
      text = `{${text}`
    }
    const startBrace = text.indexOf("{")
    const endBrace = text.lastIndexOf("}")

    // Only extract brace content if we don't have a jsonKey or if the text properly starts with a brace
    if (
      (startBrace !== -1 || endBrace !== -1) &&
      (!jsonKey || text.startsWith("{"))
    ) {
      if (startBrace !== -1) {
        if (startBrace !== 0) {
          text = text.substring(startBrace)
        }
      }
      if (endBrace !== -1) {
        if (endBrace !== text.length - 1) {
          text = text.substring(0, endBrace + 1)
        }
      }
    }
    // Handle case where we have jsonKey but text doesn't start with brace (plain text that needs wrapping)
    if (jsonKey && !text.startsWith("{") && text.trim() !== "json") {
      if (text.trim() === "answer null" && jsonKey) {
        text = `{${jsonKey} null}`
      } else {
        // Properly escape quotes and newlines in the text content
        const escapedText = text
          .replace(/\\/g, "\\\\") // Escape backslashes first
          .replace(/"/g, '\\"') // Escape quotes
          .replace(/\n/g, "\\n") // Escape newlines
          .replace(/\r/g, "\\r") // Escape carriage returns
        text = `{${jsonKey} "${escapedText}"}`
      }
    }

    if (!text.trim()) {
      return ""
    }
    try {
      jsonVal = parse(text.trim())
      if (Object.keys(jsonVal).length === 0 && text.length > 2) {
        let withNewLines = text.replace(/: "(.*?)"/gs, (match, content) => {
          const escaped = content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")
          return `: "${escaped}"`
        })
        if (jsonKey && withNewLines.startsWith("{")) {
          const startBraceIndex = withNewLines.indexOf("{")
          const keyIndex = withNewLines.indexOf(jsonKey)
          if (keyIndex > startBraceIndex) {
            withNewLines =
              withNewLines.slice(0, startBraceIndex + 1) +
              withNewLines.slice(keyIndex)
          }
        }
        jsonVal = parse(withNewLines.trim())
      }

      if (
        jsonKey &&
        text.slice(-2) === `\\"` &&
        jsonVal[jsonKey.slice(1, -2)][
          jsonVal[jsonKey.slice(1, -2)].length - 1
        ] === `"`
      ) {
        jsonVal[jsonKey.slice(1, -2)] = jsonVal[jsonKey.slice(1, -2)].slice(
          0,
          -1,
        )
      }

      if (jsonKey) {
        const key = jsonKey.slice(0, -1).replaceAll('"', "")
        if (jsonVal[key]?.trim() === "null") {
          jsonVal = { [key]: null }
        }
      }
      return jsonVal
    } catch (err) {
      Logger.error(`Initial parse failed - ${JSON.stringify(err)}`)
      // If first parse failed, continue to code block cleanup
      // throw new Error("Initial parse failed")
    }
  } catch (e) {
    try {
      text = text
        .replace(/```(json)?/g, "")
        .replace(/```/g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .trim()
      if (!text) {
        return {}
      }
      if (text === "}") {
        return {}
      }
      jsonVal = parse(text)
    } catch (parseError) {
      Logger.error(
        parseError,
        `The ai response that triggered the json parse error ${text.trim()}`,
      )
      // throw parseError
    }
  }
  return jsonVal
}

type QueryAnalysisResult = z.infer<typeof QueryAnalysisSchema>

export const analyzeQueryForNamesAndEmails = async (
  userQuery: string,
  params: ModelParams,
): Promise<{ result: QueryAnalysisResult; cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (!params.systemPrompt) {
    params.systemPrompt = peopleQueryAnalysisSystemPrompt
  }
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          text: userQuery,
        },
      ],
    },
  ]

  let { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const jsonVal = jsonParseLLMOutput(text)
    return {
      result: QueryAnalysisSchema.parse(jsonVal),
      cost: cost!,
    }
  } else {
    throw new Error("Could not get json response")
  }
}

export const userChat = (
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = userChatSystem(context)
    }

    if (!params.messages) {
      throw new Error("Cannot chat with empty messages")
    }
    return getProviderByModel(params.modelId).converseStream(
      params.messages!,
      params,
    )
  } catch (error) {
    Logger.error(error, "Error in userChat")
    throw error
  }
}
export const generateTitleUsingQuery = async (
  query: string,
  params: ModelParams,
  assistantResponse?: string,
): Promise<{ title: string; cost: number }> => {
  Logger.info("inside generateTitleUsingQuery")
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = generateTitleSystemPrompt
    }

    params.json = true
    Logger.info("inside generateTitleUsingQuery")
    if (assistantResponse === undefined) {
      assistantResponse = ""
    }

    let { text, cost } = await getProviderByModel(params.modelId).converse(
      [
        {
          role: "user",
          content: [
            {
              text: `First user query:
${query}

Assistant response:
${assistantResponse}
        `,
            },
          ],
        },
      ],
      params,
    )
    Logger.info("after getProvider generateTitleUsingQuery")
    if (isReasoning && text?.includes(EndThinkingToken)) {
      text = text?.split(EndThinkingToken)[1]
    }
    if (text) {
      let jsonVal
      try {
        jsonVal = jsonParseLLMOutput(text)
      } catch (err) {
        Logger.error(err, `Failed to parse LLM output for title: ${text}`)
        jsonVal = undefined
      }
      let title = "Untitled"
      if (
        jsonVal &&
        typeof jsonVal.title === "string" &&
        jsonVal.title.trim()
      ) {
        title = jsonVal.title.trim()
      } else {
        Logger.error(
          `LLM output did not contain a valid title. Raw output: ${text}`,
        )
      }
      return {
        title,
        cost: cost!,
      }
    } else {
      throw new Error("Could not get json response")
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Error generating title: ${errMessage} ${(error as Error).stack}`,
    )
    throw error
  }
}

export const askQuestionWithCitations = (
  query: string,
  userContext: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    params.systemPrompt = chatWithCitationsSystemPrompt(userContext)
    params.json = true
    const baseMessage: Message = {
      role: MessageRole.User as const,
      content: [
        {
          text: `User query: ${query}
Based on the following context, provide an answer in JSON format with citations.
Context:
${context}`,
        },
      ],
    }

    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    return getProviderByModel(params.modelId).converseStream(messages, params)
  } catch (error) {
    Logger.error(error, "Error in askQuestionWithCitations")
    throw error
  }
}

export const analyzeInitialResultsOrRewrite = (
  userQuery: string,
  context: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentAnalyzeInitialResultsOrRewriteSystemPrompt(
      userCtx,
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = analyzeInitialResultsOrRewriteSystemPrompt(userCtx)
  }
  const baseMessage: Message = {
    role: MessageRole.User as const,
    content: [
      {
        text: `User query: ${userQuery}
      Based on the following context, provide an answer in JSON format with citations
      Context:
      ${context}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const analyzeInitialResultsOrRewriteV2 = (
  userQuery: string,
  context: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentAnalyzeInitialResultsOrRewriteV2SystemPrompt(
      userCtx,
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = analyzeInitialResultsOrRewriteV2SystemPrompt(userCtx)
  }
  const baseMessage: Message = {
    role: MessageRole.User as const,
    content: [
      {
        text: `User query: ${userQuery}
      Based on the following context, provide an answer in JSON format with citations
      Context:
      ${context}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const rewriteQuery = async (
  query: string,
  userCtx: string,
  params: ModelParams,
  searchContext?: string,
): Promise<{ rewrittenQueries: string[]; cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (!params.systemPrompt) {
    params.systemPrompt = rewriteQuerySystemPrompt(!!searchContext)
  }

  params.json = true

  const messages: Message[] = [
    {
      role: MessageRole.User as const,
      content: [
        {
          text: `User Query: "${query}"
User Context: "${userCtx}"${searchContext ? `\nSearch Context:\n${searchContext}` : ""}`,
        },
      ],
    },
  ]

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const jsonVal = jsonParseLLMOutput(text)
    return {
      rewrittenQueries: jsonVal.rewrittenQueries.map((q: string) => q.trim()),
      cost: cost!,
    }
  } else {
    throw new Error("Failed to rewrite query")
  }
}

export const answerOrSearch = (
  userQuery: string,
  context: string,
  userCtx: string,
  dateForAI: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      params.systemPrompt = agentOptimizedPrompt(
        userCtx,
        dateForAI,
        parseAgentPrompt(params.agentPrompt),
      )
    } else {
      params.systemPrompt = optimizedPrompt(userCtx, dateForAI)
    }
    params.json = true

    const baseMessage: Message = {
      role: MessageRole.User,
      content: [
        {
          text: `User Query: ${userQuery}\n\nAfter searching permission aware Context:\n${context}\n it can have mistakes so be careful`,
        },
      ],
    }

    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    return getProviderByModel(params.modelId).converseStream(messages, params)
  } catch (error) {
    Logger.error(error, "Error in answerOrSearch")
    throw error
  }
}

export enum QueryType {
  RetrieveInformation = "RetrieveInformation",
  ListItems = "ListItems",
}

export const listItems = (
  query: string,
  userCtx: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentGenerateMarkdownTableSystemPrompt(
      userCtx,
      query,
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = generateMarkdownTableSystemPrompt(userCtx, query)
  }
  const baseMessage: Message = {
    role: MessageRole.User,
    content: [
      {
        text: `Please format the following data as a markdown table:

Context:
${context}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const baselineRAG = async (
  userQuery: string,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): Promise<{ text: string; cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentBaselinePrompt(
      userCtx,
      retrievedCtx,
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = baselinePrompt(userCtx, retrievedCtx)
  }
  params.json = false

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }

  params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    return {
      text,
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

export const baselineRAGJson = async (
  userQuery: string,
  userCtx: string,
  dateForAI: string,
  retrievedCtx: string,
  params: ModelParams,
): Promise<{ output: AnswerResponse; cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentBaselinePromptJson(
      userCtx,
      retrievedCtx,
      parseAgentPrompt(params.agentPrompt),
      dateForAI,
    )
  } else {
    params.systemPrompt = baselinePromptJson(userCtx, retrievedCtx, dateForAI)
  }
  params.json = true
  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }
  params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )
  if (text) {
    const parsedResponse = jsonParseLLMOutput(text)
    return {
      output: parsedResponse,
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

const indexToCitation = (text: string): string => {
  return text.replace(/Index (\d+)/g, "[$1]")
}

export const baselineRAGJsonStream = (
  userQuery: string,
  userCtx: string,
  userMetadata: UserMetadataType,
  retrievedCtx: string,
  params: ModelParams,
  specificFiles?: boolean,
  isMsgWithKbItems?: boolean,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }

  let defaultReasoning = isReasoning

  if (params.reasoning !== undefined) {
    defaultReasoning = params.reasoning
  }

  if (specificFiles) {
    Logger.info("Using baselineFilesContextPromptJson")
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      if (isMsgWithKbItems) {
        params.systemPrompt = agentBaselineKbContextPromptJson(
          userCtx,
          userMetadata.dateForAI,
          retrievedCtx,
          parseAgentPrompt(params.agentPrompt),
        )
      } else {
        params.systemPrompt = agentBaselineFilesContextPromptJson(
          userCtx,
          indexToCitation(retrievedCtx),
          parseAgentPrompt(params.agentPrompt),
        )
      }
    } else {
      if (isMsgWithKbItems) {
        params.systemPrompt = agentBaselineKbContextPromptJson(
          userCtx,
          userMetadata.dateForAI,
          retrievedCtx,
        )
      } else {
        params.systemPrompt = baselineFilesContextPromptJson(
          userCtx,
          indexToCitation(retrievedCtx),
        )
      }
    }
  } else if (defaultReasoning) {
    Logger.info("Using baselineReasoningPromptJson")
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      params.systemPrompt = agentBaselineReasoningPromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
        parseAgentPrompt(params.agentPrompt),
      )
    } else {
      params.systemPrompt = baselineReasoningPromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
      )
    }
  } else {
    Logger.info("Using baselinePromptJson")

    if (!isAgentPromptEmpty(params.agentPrompt)) {
      params.systemPrompt = agentBaselinePromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
        parseAgentPrompt(params.agentPrompt),
        userMetadata.dateForAI,
      )
    } else {
      params.systemPrompt = baselinePromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
        userMetadata.dateForAI,
      )
    }
  }
  params.json = true

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const baselineRAGOffJsonStream = (
  userQuery: string,
  userCtx: string,
  dateForAI: string,
  retrievedCtx: string,
  params: ModelParams,
  agentPrompt: string,
  messages: Message[],
  attachmentFileIds?: string[],
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }

  params.systemPrompt = ragOffPromptJson(
    userCtx,
    retrievedCtx,
    dateForAI,
    parseAgentPrompt(agentPrompt),
  )
  params.json = true

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }


  const updatedMessages: Message[] = messages
    ? [...messages, baseMessage]
    : [baseMessage]
  return getProviderByModel(params.modelId).converseStream(
    updatedMessages,
    params,
  )
}

export const temporalPromptJsonStream = (
  userQuery: string,
  userCtx: string,
  dateForAI: string,
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentTemporalDirectionJsonPrompt(
      userCtx,
      retrievedCtx,
      parseAgentPrompt(params.agentPrompt),
      dateForAI,
    )
  } else {
    params.systemPrompt = temporalDirectionJsonPrompt(
      userCtx,
      retrievedCtx,
      dateForAI,
    )
  }
  params.json = true
  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }
  params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const mailPromptJsonStream = (
  userQuery: string,
  userCtx: string,
  dateForAI: string,
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  let defaultReasoning = isReasoning
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (params.reasoning !== undefined) {
    defaultReasoning = params.reasoning
  }
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentEmailPromptJson(
      userCtx,
      retrievedCtx,
      parseAgentPrompt(params.agentPrompt),
      dateForAI,
    )
  } else if (defaultReasoning) {
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      params.systemPrompt = agentBaselineReasoningPromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
        parseAgentPrompt(params.agentPrompt),
      )
    } else {
      params.systemPrompt = baselineReasoningPromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
      )
    }
  } else {
    params.systemPrompt = emailPromptJson(userCtx, retrievedCtx, dateForAI)
  }
  params.json = true
  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }
  params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const meetingPromptJsonStream = (
  userQuery: string,
  userCtx: string,
  dateForAI: string,
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  params.systemPrompt = meetingPromptJson(userCtx, retrievedCtx, dateForAI)
  params.json = true // Set to true to ensure JSON response
  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `${userQuery}`,
      },
    ],
  }
  params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  return getProviderByModel(params.modelId).converseStream(messages, params)
}

interface RewrittenQueries {
  queries: string[]
}

export const queryRewriter = async (
  userQuery: string,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): Promise<RewrittenQueries & { cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentQueryRewritePromptJson(
      userCtx,
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = queryRewritePromptJson(userCtx, retrievedCtx)
  }
  params.json = true

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `query: "${userQuery}"`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const parsedResponse = jsonParseLLMOutput(text)
    return {
      queries: parsedResponse.queries || [],
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

export const temporalEventClassification = async (
  userQuery: string,
  params: ModelParams,
): Promise<Omit<TemporalClassifier, "filterQuery"> & { cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  params.json = true

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `query: "${userQuery}"`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const parsedResponse = jsonParseLLMOutput(text)
    return {
      direction: parsedResponse.direction || null,
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

export async function generateToolSelectionOutput(
  userQuery: string,
  userContext: string,
  toolContext: string,
  initialPlanning: string,
  params: ModelParams,
  agentContext?: string,
  pastActions?: string,
  tools?: {
    internal?: Record<string, ToolDefinition> | undefined
    slack?: Record<string, ToolDefinition> | undefined
  },
  isDebugMode?: boolean,
): Promise<{
  queryRewrite: string
  tool: string
  arguments: Record<string, any>
  reasoning?: string | null
} | null> {
  params.json = true
  const dateForAI = getDateForAI({ userTimeZone: "Asia/Kolkata" })

  let defaultReasoning = isReasoning
  params.systemPrompt = SearchQueryToolContextPrompt(
    userContext,
    toolContext,
    initialPlanning,
    dateForAI,
    parseAgentPrompt(agentContext),
    pastActions,
    tools,
    isDebugMode,
  )

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `user query: "${userQuery}"`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    const jsonVal = jsonParseLLMOutput(text)
    return {
      queryRewrite: jsonVal.queryRewrite || "",
      tool: jsonVal.tool,
      arguments: jsonVal.arguments || {},
      reasoning: jsonVal.reasoning || null,
    }
  } else {
    throw new Error("Failed to rewrite query")
  }
}

export function generateSearchQueryOrAnswerFromConversation(
  currentMessage: string,
  userContext: string,
  userMetadata: UserMetadataType,
  params: ModelParams,
  toolContext?: string,
  previousClassification?: QueryRouterLLMResponse | null,
  chainBreakClassifications?: ChainBreakClassifications | null,
): AsyncIterableIterator<ConverseResponse> {
  params.json = true
  let defaultReasoning = isReasoning

  if (params.reasoning !== undefined) {
    defaultReasoning = params.reasoning
  }

  if (defaultReasoning) {
    params.systemPrompt = searchQueryReasoningPrompt(userContext)
  } else if (!isAgentPromptEmpty(params.agentPrompt)) {
    params.systemPrompt = agentSearchQueryPrompt(
      userContext,
      userMetadata.dateForAI,
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = searchQueryPrompt(
      userContext,
      userMetadata.dateForAI,
      previousClassification,
      chainBreakClassifications,
    )
  }

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `user query: "${currentMessage}"`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export function generateAnswerBasedOnToolOutput(
  currentMessage: string,
  userContext: string,
  dateForAI: string,
  params: ModelParams,
  toolContext: string,
  toolOutput: string,
  agentContext?: string,
  fallbackReasoning?: string,
): AsyncIterableIterator<ConverseResponse> {
  params.json = true
  if (!isAgentPromptEmpty(agentContext)) {
    const parsedAgentPrompt = parseAgentPrompt(agentContext)
    const defaultSystemPrompt = withToolQueryPrompt(
      userContext,
      toolContext,
      toolOutput,
      dateForAI,
      parsedAgentPrompt,
      fallbackReasoning,
    )
    params.systemPrompt = defaultSystemPrompt
  } else {
    params.systemPrompt = withToolQueryPrompt(
      userContext,
      toolContext,
      toolOutput,
      dateForAI,
      undefined,
      fallbackReasoning,
    )
  }

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `user query: "${currentMessage}"`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export function generateSynthesisBasedOnToolOutput(
  userCtx: string,
  dateForAI: string,
  currentMessage: string,
  gatheredFragments: string,
  params: ModelParams,
  agentContext?: string,
): Promise<ConverseResponse> {
  params.json = true

  params.systemPrompt = synthesisContextPrompt(
    userCtx,
    currentMessage,
    gatheredFragments,
    dateForAI,
  )

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `user-query: "${currentMessage}"`,
      },
    ],
  }

  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]

  return getProviderByModel(params.modelId).converse(messages, params)
}

export const generatePromptFromRequirements = async function* (
  requirements: string,
  params: ModelParams,
): AsyncGenerator<{ text?: string; cost?: number }, void, unknown> {
  Logger.info("Starting prompt generation from requirements")

  try {
    if (!params.modelId) {
      params.modelId = defaultFastModel
    }

    params.systemPrompt = promptGenerationSystemPrompt
    params.stream = true

    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [
          {
            text: `Please create an effective AI agent prompt based on these requirements: ${requirements}`,
          },
        ],
      },
    ]

    const iterator = getProviderByModel(params.modelId).converseStream(
      messages,
      params,
    )

    for await (const chunk of iterator) {
      yield chunk
    }

    Logger.info("Prompt generation completed successfully")
  } catch (error) {
    Logger.error(error, "Error in generatePromptFromRequirements")
    throw error
  }
}

export const generateFallback = async (
  userContext: string,
  originalQuery: string,
  agentScratchpad: string,
  toolLog: string,
  gatheredFragments: string,
  params: ModelParams,
): Promise<{
  reasoning: string
  cost: number
}> => {
  Logger.info("Starting fallback reasoning generation")

  try {
    if (!params.modelId) {
      params.modelId = defaultFastModel
    }

    params.systemPrompt = fallbackReasoningGenerationPrompt(
      userContext,
      originalQuery,
      agentScratchpad,
      toolLog,
      gatheredFragments,
    )
    params.json = true

    const messages: Message[] = [
      {
        role: ConversationRole.USER,
        content: [
          {
            text: `Analyze why the search failed for the original query: "${originalQuery}"`,
          },
        ],
      },
    ]

    const { text, cost } = await getProviderByModel(params.modelId).converse(
      messages,
      params,
    )

    if (text) {
      const parsedResponse = jsonParseLLMOutput(text)
      Logger.info("Fallback reasoning generation completed successfully")
      return {
        reasoning: parsedResponse.reasoning || "No reasoning provided",
        cost: cost!,
      }
    } else {
      throw new Error("No response from LLM for fallback reasoning generation")
    }
  } catch (error) {
    Logger.error(error, "Error in generateFallback")
    throw error
  }
}

export const extractEmailsFromContext = async (
  names: MailParticipant,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): Promise<{ emails: MailParticipant }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }

  const participants =
    [
      ...(names.from?.length ? [`From: ${names.from.join(", ")}`] : []),
      ...(names.to?.length ? [`To: ${names.to.join(", ")}`] : []),
      ...(names.cc?.length ? [`CC: ${names.cc.join(", ")}`] : []),
      ...(names.bcc?.length ? [`BCC: ${names.bcc.join(", ")}`] : []),
    ].join(" | ") || "No names provided"

  params.systemPrompt = nameToEmailResolutionPrompt(
    userCtx,
    retrievedCtx,
    participants,
    names,
  )
  params.json = false

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `Help me find emails for these names: ${participants}`,
      },
    ],
  }

  const updatedMessages: Message[] = [baseMessage]
  const res = await getProviderByModel(params.modelId).converse(
    updatedMessages,
    params,
  )

  let parsedResponse = []
  if (!res || !res.text) {
    Logger.error("No response from LLM for email extraction")
  }
  if (res.text) {
    parsedResponse = jsonParseLLMOutput(res.text)
  }
  const emails = parsedResponse.emails || {}
  return {
    emails: {
      bcc: emails.bcc || [],
      cc: emails.cc || [],
      from: emails.from || [],
      to: emails.to || [],
    },
  }
}

export const generateFollowUpQuestions = async (
  userQuery: string,
  systemPrompt: string,
  params: ModelParams,
): Promise<{ followUpQuestions: string[] }> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultFastModel
    }

    params.systemPrompt = systemPrompt
    params.json = true

    const { text, cost } = await getProviderByModel(params.modelId).converse(
      [
        {
          role: "user",
          content: [
            {
              text: userQuery,
            },
          ],
        },
      ],
      params,
    )

    if (text) {
      let jsonVal
      try {
        jsonVal = jsonParseLLMOutput(text)
      } catch (err) {
        Logger.error(
          err,
          `Failed to parse LLM output for follow-up questions: ${text}`,
        )
        return { followUpQuestions: [] }
      }

      if (jsonVal && Array.isArray(jsonVal.followUpQuestions)) {
        return {
          followUpQuestions: jsonVal.followUpQuestions.filter(
            (q: any) => typeof q === "string" && q.trim().length > 0,
          ),
        }
      } else {
        Logger.error(
          `LLM output did not contain valid follow-up questions. Raw output: ${text}`,
        )
        return { followUpQuestions: [] }
      }
    } else {
      throw new Error("Could not get response from LLM")
    }
  } catch (error) {
    Logger.error(error, "Error generating follow-up questions")
    return { followUpQuestions: [] }
  }
}

export const webSearchQuestion = (
  query: string,
  userCtx: string,
  params: ModelParams,
  webSearchCitations?: { title: string; url: string }[],
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }
    params.webSearch = true

    if (!params.systemPrompt) {
      if (!isAgentPromptEmpty(params.agentPrompt)) {
        const parsed = parseAgentPrompt(params.agentPrompt)
        params.systemPrompt = webSearchSystemPrompt(
          userCtx,
          parsed,
          webSearchCitations,
        )
      } else {
        params.systemPrompt = webSearchSystemPrompt(
          userCtx,
          undefined,
          webSearchCitations,
        )
      }
    }
    const baseMessage: Message = {
      role: MessageRole.User,
      content: [{ text: query }],
    }
    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    if (!config.VertexProjectId || !config.VertexRegion) {
      Logger.warn(
        "VertexProjectId/VertexRegion not configured, moving with default provider.",
      )
      return getProviderByModel(params.modelId).converseStream(messages, params)
    }
    const vertexGoogleProvider = new VertexAiProvider({
      projectId: config.VertexProjectId!,
      region: config.VertexRegion!,
      provider: VertexProvider.GOOGLE,
    })

    return vertexGoogleProvider.converseStream(messages, params)
  } catch (error) {
    Logger.error(error, "Error in webSearchQuestion")
    throw error
  }
}

export const getDeepResearchResponse = (
  query: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = Models.o3_Deep_Research
    }

    params.webSearch = true

    if (!params.systemPrompt) {
      params.systemPrompt = !isAgentPromptEmpty(params.agentPrompt)
        ? deepResearchPrompt(userCtx) +
          "\n\n" +
          parseAgentPrompt(params.agentPrompt)
        : deepResearchPrompt(userCtx)
    }

    const baseMessage: Message = {
      role: MessageRole.User,
      content: [{ text: query }],
    }
    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    const openAIKey = process.env["DS_OPENAI_API_KEY"]
    const baseUrl = process.env["DS_BASE_URL"]
    if (!openAIKey) {
      Logger.warn("OpenAIKey not configured, moving with default provider.")
      return getProviderByModel(params.modelId).converseStream(messages, params)
    }

    const openAIClient = new OpenAI({
      apiKey: openAIKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    })
    const openaiProvider = new OpenAIProvider(openAIClient)

    return openaiProvider.converseStream(messages, params)
  } catch (error) {
    Logger.error(error, "Error in webSearchQuestion")
    throw error
  }
}

export const agentWithNoIntegrationsQuestion = (
  query: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }
    if (!params.systemPrompt) {
      if (!isAgentPromptEmpty(params.agentPrompt)) {
        const agentPromptData = parseAgentPrompt(params.agentPrompt)
        params.systemPrompt =
          askQuestionSystemPrompt + "\n\n" + agentPromptData.prompt
      } else {
        params.systemPrompt = agentWithNoIntegrationsSystemPrompt
      }
    }

    const baseMessage: Message = {
      role: MessageRole.User,
      content: [{ text: query }],
    }
    const messages: Message[] = params.messages
      ? [...params.messages, baseMessage]
      : [baseMessage]

    return getProviderByModel(params.modelId).converseStream(messages, params)
  } catch (error) {
    Logger.error(error, "Error in agentWithNoIntegrationsQuestion")
    throw error
  }
}

export const extractBestDocumentIndexes = async (
  query: string,
  retrievedContext: string[],
  params: ModelParams,
  messages: Message[],
): Promise<number[]> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }

    params.systemPrompt = extractBestDocumentsPrompt(query, retrievedContext)

    const baseMessage: Message = {
      role: "user",
      content: [
        {
          text: query,
        },
      ],
    }

    // Combine history messages with the current query
    const allMessages: Message[] =
      messages && messages.length > 0
        ? [...messages, baseMessage]
        : [baseMessage]

    const { text, cost } = await getProviderByModel(params.modelId).converse(
      allMessages,
      params,
    )

    if (!text) {
      Logger.warn("No text returned from model")
      return []
    }

    // Extract indexes block between <indexes> ... </indexes>
    const match = text.match(/<indexes>([\s\S]*?)<\/indexes>/i)
    const extracted = match ? match[1].trim() : text.trim()

    let indexes: number[] = []
    try {
      const parsed = JSON.parse(extracted)
      if (Array.isArray(parsed)) {
        indexes = parsed.filter((n) => typeof n === "number")
      }
    } catch {
      Logger.info("Failed to extract document indexes")
    }

    Logger.info(
      `"Extracted best document indexes" : indexes: ${indexes}, cost: ${cost}`,
    )
    return indexes
  } catch (error) {
    Logger.error(error, "Error in extractBestDocumentIndexes")
    throw error
  }
}
