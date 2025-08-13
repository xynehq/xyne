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
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { parse } from "partial-json"

import { ModelToProviderMap } from "@/ai/mappers"
import type {
  AnswerResponse,
  ConverseResponse,
  Cost,
  Intent,
  LLMProvider,
  ModelParams,
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
import { VertexAiProvider } from "@/ai/provider/vertex_ai"
import {
  agentAnalyzeInitialResultsOrRewriteSystemPrompt,
  agentAnalyzeInitialResultsOrRewriteV2SystemPrompt,
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
      typeof parsed.prompt === "string" &&
      Array.isArray(parsed.appIntegrations)
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
    Logger.info(
      `Agent prompt string is not valid JSON or is empty. Treating as literal prompt: '${agentPromptString}'`,
    )
    return { ...defaults, prompt: agentPromptString }
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
    const ollama = new Ollama()
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
    vertexProvider = new VertexAiProvider({
      projectId: VertexProjectId,
      region: VertexRegion,
    })
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
            : VertexAIModel
              ? AIProviders.VertexAI
              : null

  if (!providerType) {
    throw new Error("Invalid provider type")
  }
  const provider = ProviderMap[providerType]
  if (!provider) {
    throw new Error("Invalid provider")
  }
  return provider
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

    let { text, cost } = await getProviderByModel(params.modelId).converse(
      [
        {
          role: "user",
          content: [
            {
              text: query,
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
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      params.systemPrompt = agentOptimizedPrompt(
        userCtx,
        parseAgentPrompt(params.agentPrompt),
      )
    } else {
      params.systemPrompt = optimizedPrompt(userCtx)
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
    )
  } else {
    params.systemPrompt = baselinePromptJson(userCtx, retrievedCtx)
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
    if (!parsedResponse) {
      throw new Error("Failed to parse LLM response as JSON")
    }
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
  retrievedCtx: string,
  params: ModelParams,
  specificFiles?: boolean,
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
    params.systemPrompt = baselineFilesContextPromptJson(
      userCtx,
      indexToCitation(retrievedCtx),
    )
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
      )
    } else {
      params.systemPrompt = baselinePromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
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

  if (isAgentPromptEmpty(params.agentPrompt)) params.messages = []
  const messages: Message[] = params.messages
    ? [...params.messages, baseMessage]
    : [baseMessage]
  return getProviderByModel(params.modelId).converseStream(messages, params)
}

export const baselineRAGOffJsonStream = (
  userQuery: string,
  userCtx: string,
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

  if (isAgentPromptEmpty(params.agentPrompt)) params.messages = []
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
    )
  } else {
    params.systemPrompt = temporalDirectionJsonPrompt(userCtx, retrievedCtx)
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
    params.systemPrompt = emailPromptJson(userCtx, retrievedCtx)
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
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  params.systemPrompt = meetingPromptJson(userCtx, retrievedCtx)
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
    if (!parsedResponse) {
      throw new Error("Failed to parse LLM response as JSON")
    }
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
    if (!parsedResponse) {
      throw new Error("Failed to parse LLM response as JSON")
    }
    return {
      direction: parsedResponse.direction || null,
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

// Helper function to extract URLs from text
function extractUrlsFromText(text: string): string[] {
  Logger.info(`[extractUrlsFromText] Input text length: ${text.length}`)
  Logger.info(
    `[extractUrlsFromText] Input text preview: ${text.substring(0, 1000)}...`,
  )

  // Handle structured data by extracting text content first
  let cleanText = text
  let documentContent = text

  try {
    // Try to parse as JSON and extract text values if it's structured data
    if (text.includes('"type"') && text.includes('"value"')) {
      const matches = text.match(/"value":"([^"]+)"/g)
      if (matches) {
        cleanText = matches
          .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
          .join(" ")
        Logger.info(
          `[extractUrlsFromText] Extracted clean text from structured data: ${cleanText.substring(0, 500)}...`,
        )
      }
    }

    // **ENHANCED ATTACHMENT DETECTION**
    // Look for strong indicators that this is attached document content
    const attachmentIndicators = [
      /file.*content/i, // File content indicators
      /attachment.*content/i, // Attachment content
      /document.*attached/i, // Document attachment indicators
      /pdf.*content/i, // PDF content
      /uploaded.*file/i, // Uploaded file content
      /document.*content/i, // Document content indicators
      /https?:\/\/[^\s]+/i, // URLs in content (strong indicator)
      /www\.[^\s]+/i, // www URLs
      /article/i, // Article content
      /tutorial/i, // Tutorial content
      /guide/i, // Guide content
      /blog/i, // Blog content
      /news/i, // News content
      /reference/i, // Reference content
      /manual/i, // Manual content
      /documentation/i, // Documentation content
      /instructions/i, // Instructions content
      /\.com\/[^\s]+/i, // URLs with paths
      /\.org\/[^\s]+/i, // Organization URLs with paths
      /\.edu\/[^\s]+/i, // Educational URLs with paths
      /\.gov\/[^\s]+/i, // Government URLs with paths
      /\.io\/[^\s]+/i, // Tech URLs with paths
      /\.net\/[^\s]+/i, // Network URLs with paths
    ]

    // Split text into sections and score them based on attachment/document indicators
    const sections = cleanText
      .split(/\n\n|\n---|\n===/)
      .filter((section) => section.trim().length > 50)
    let bestSection = cleanText
    let bestScore = 0

    Logger.info(
      `[extractUrlsFromText] Found ${sections.length} sections to analyze`,
    )

    for (const section of sections) {
      let score = 0
      for (const indicator of attachmentIndicators) {
        if (indicator.test(section)) {
          score += 1
        }
      }

      // **STRONG BONUS** for sections with URLs (likely document content)
      const urlCount = (section.match(/https?:\/\/[^\s]+/g) || []).length
      if (urlCount > 0) {
        score += urlCount * 3 // Strong bonus for URLs
        Logger.info(
          `[extractUrlsFromText] Section has ${urlCount} URLs, adding bonus score`,
        )
      }

      // Penalize sections that look like email signatures or metadata
      if (
        section.includes("@") &&
        section.includes(".com") &&
        !section.includes("http")
      ) {
        score -= 3 // Strong penalty for email-like content without URLs
      }
      if (
        section.toLowerCase().includes("signature") ||
        section.toLowerCase().includes("confidential")
      ) {
        score -= 2 // Penalty for email signatures
      }
      if (
        section.toLowerCase().includes("unsubscribe") ||
        section.toLowerCase().includes("email marketing")
      ) {
        score -= 4 // Strong penalty for email marketing content
      }

      Logger.info(
        `[extractUrlsFromText] Section score: ${score} for section: ${section.substring(0, 100)}...`,
      )

      if (score > bestScore && score > 0) {
        bestScore = score
        bestSection = section
        Logger.info(
          `[extractUrlsFromText] Found better document section with score ${score}`,
        )
      }
    }

    if (bestScore > 0) {
      documentContent = bestSection
      Logger.info(
        `[extractUrlsFromText] Using prioritized document content with score ${bestScore}: ${documentContent.substring(0, 200)}...`,
      )
    } else {
      Logger.info(
        `[extractUrlsFromText] No high-scoring sections found, using full text`,
      )
    }
  } catch (e) {
    Logger.info(
      `[extractUrlsFromText] Using original text as no structured data found`,
    )
  }

  // More comprehensive URL regex patterns to catch different formats
  const urlPatterns = [
    /(https?:\/\/[^\s\)\],"\'\>\<\}]+)/g, // Standard HTTP(S) URLs
    /(www\.[^\s\)\],"\'\>\<\}]+\.[a-z]{2,})/gi, // www. URLs
    /(https?:\/\/[^\s]+)/g, // Very permissive HTTP(S) pattern
    /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*/gi, // Direct HTTP URLs
    /www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*/gi, // Direct www URLs
    /[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/[^\s\)\],"\'\>\<\}]+/gi, // Domain URLs with paths (any TLD)
    /[a-zA-Z0-9.-]+\.(?:com|org|net|edu|gov|io|co\.uk|de|fr|jp|au|ca)\/[^\s]*/gi, // Common TLD URLs with paths
  ]

  let urls: string[] = []

  // Try each pattern on prioritized document content first, then fall back to clean text
  const textSources = [documentContent, cleanText]

  for (const textSource of textSources) {
    for (let i = 0; i < urlPatterns.length; i++) {
      const pattern = urlPatterns[i]
      const matches = textSource.match(pattern)
      if (matches) {
        Logger.info(
          `[extractUrlsFromText] Pattern ${i} found ${matches.length} matches in ${textSource === documentContent ? "document content" : "clean text"}: ${JSON.stringify(matches)}`,
        )
        urls.push(...matches)
      }
    }

    // If we found URLs in document content, prefer those and stop
    if (textSource === documentContent && urls.length > 0) {
      Logger.info(
        `[extractUrlsFromText] Found URLs in prioritized document content, using those`,
      )
      break
    }
  }

  Logger.info(
    `[extractUrlsFromText] Raw extracted URLs before filtering: ${JSON.stringify(urls)}`,
  )

  // Filter out problematic URLs that we know won't work
  const problematicPatterns = [
    /mail\.google\.com/i,
    /accounts\.google\.com/i,
    /login\.|\/login/i,
    /signin\.|\/signin/i,
    /auth\.|\/auth/i,
    /\.pdf$/i, // Don't try to scrape PDF URLs directly
    /localhost/i,
    /127\.0\.0\.1/i,
    /\.onion/i,
    /^\w+\.\w+$/, // Filter out simple domain names without paths like "user.domain"
    /@/, // Filter out email addresses completely
    /^https?:\/\/[^\/]*@/, // Filter out URLs with @ symbols (malformed email-like URLs)
    /\.(jpg|jpeg|png|gif|bmp|svg|ico)$/i, // Filter out image files
    /\.(mp4|mp3|avi|mov|wmv|flv|webm)$/i, // Filter out media files
    /\.(zip|rar|tar|gz|exe|dmg)$/i, // Filter out archive/executable files
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/i, // Email address pattern
  ]

  Logger.info(
    `[extractUrlsFromText] Raw extracted URLs before filtering: ${JSON.stringify(urls)}`,
  )

  urls = urls.filter((url) => {
    // Skip email addresses and email-like URLs
    if (
      url.includes("@") ||
      url.match(/^[^\/]*@[^\/]*$/) ||
      url.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)
    ) {
      Logger.info(`[extractUrlsFromText] Filtering out email-like URL: ${url}`)
      return false
    }

    // Skip URLs that are just domain names without proper URL structure
    if (
      url.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/) &&
      !url.startsWith("http") &&
      !url.startsWith("www")
    ) {
      Logger.info(`[extractUrlsFromText] Filtering out bare domain: ${url}`)
      return false
    }

    for (const pattern of problematicPatterns) {
      if (pattern.test(url)) {
        Logger.info(
          `[extractUrlsFromText] Filtering out problematic URL: ${url}`,
        )
        return false
      }
    }
    return true
  })

  // Clean and normalize URLs
  urls = urls.map((url) => {
    // Remove trailing punctuation and common JSON artifacts
    url = url.replace(/[,.)}\]"'>]+$/, "")
    url = url.replace(/","title.*$/, "") // Remove JSON artifacts
    url = url.replace(/\\".*$/, "") // Remove escaped quotes and following content

    // Add https:// if missing for www. URLs
    if (url.startsWith("www.")) {
      return `https://${url}`
    }
    return url
  })

  // Remove duplicates and validate URLs - only keep valid HTTP/HTTPS URLs
  const validUrls = [...new Set(urls)]
    .filter((url) => {
      try {
        const urlObj = new URL(url)
        const isValidProtocol =
          urlObj.protocol === "http:" || urlObj.protocol === "https:"
        const isLongEnough = url.length > 10

        // **ENHANCED FILTERING**: Be less restrictive for attachment content
        const hostname = urlObj.hostname.toLowerCase()

        // Only filter out truly problematic domains for attachment content
        const isSystemDomain =
          hostname.includes("unsubscribe") ||
          hostname.includes("tracking") ||
          hostname.includes("analytics") ||
          hostname.includes("login.") ||
          hostname.includes("signin.") ||
          hostname.includes("auth.")

        // **RELAXED FILTERING**: Allow more URLs from attachment content if they have good paths
        const hasContentPath =
          urlObj.pathname &&
          urlObj.pathname.length > 1 &&
          urlObj.pathname !== "/"
        const isContentUrl =
          hasContentPath ||
          hostname.includes("blog") ||
          hostname.includes("docs") ||
          hostname.includes("documentation") ||
          hostname.includes("support") ||
          hostname.includes("help") ||
          hostname.includes("article") ||
          hostname.includes("news") ||
          hostname.includes("tutorial") ||
          hostname.includes("guide") ||
          hostname.includes("manual") ||
          hostname.includes("reference") ||
          hostname.includes("nasa.gov") ||
          hostname.includes("gov") ||
          hostname.includes("edu") ||
          hostname.includes("wikipedia") ||
          hostname.includes("github")

        // **PRIORITY LOGIC**: If this looks like content from an attachment, be more permissive
        const isFromAttachment =
          documentContent.includes("ATTACHMENT CONTENT") ||
          documentContent.includes("=== ATTACHMENT CONTENT START")

        if (isFromAttachment && isContentUrl) {
          Logger.info(
            `[extractUrlsFromText] Prioritizing attachment content URL: ${url}`,
          )
          return isValidProtocol && isLongEnough && !isSystemDomain
        }

        if (isContentUrl) {
          Logger.info(`[extractUrlsFromText] Prioritizing content URL: ${url}`)
          return isValidProtocol && isLongEnough && !isSystemDomain
        }

        if (isSystemDomain) {
          Logger.info(
            `[extractUrlsFromText] Filtering out system domain URL: ${url}`,
          )
          return false
        }

        // Accept any valid URL that's not a system domain and has a good length
        return isValidProtocol && isLongEnough
      } catch {
        Logger.info(`[extractUrlsFromText] Invalid URL format: ${url}`)
        return false
      }
    })
    .slice(0, 5) // Limit to 5 URLs max  Logger.info(`[extractUrlsFromText] Final extracted URLs: ${JSON.stringify(validUrls)}`)

  return validUrls
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

  let defaultReasoning = isReasoning
  params.systemPrompt = SearchQueryToolContextPrompt(
    userContext,
    toolContext,
    initialPlanning,
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

  // **PRIORITY 1: Check attached document content FIRST**
  // Look for attached document content in userContext - this should be the primary source
  Logger.info(
    `[generateToolSelectionOutput] Checking for attached document content in userContext`,
  )
  Logger.info(
    `[generateToolSelectionOutput] UserContext length: ${userContext.length}, preview: ${userContext.substring(0, 500)}...`,
  )

  // **ENHANCED**: First check if userContext contains attachment content markers
  const hasAttachmentContent =
    userContext.includes("ATTACHED DOCUMENT CONTENT:") ||
    userContext.includes("=== ATTACHMENT CONTENT START")

  if (hasAttachmentContent) {
    Logger.info(
      `[generateToolSelectionOutput] Found attachment content markers in userContext`,
    )
    const documentUrls = extractUrlsFromText(userContext)
    if (documentUrls.length > 0) {
      Logger.info(
        `[generateToolSelectionOutput] FOUND ${documentUrls.length} URLs in attached document content - PRIORITIZING web scraper`,
      )

      // Extract clean query text from userQuery if it contains structured data
      let cleanQuery = userQuery
      try {
        if (userQuery.includes('"type"') && userQuery.includes('"value"')) {
          const textMatches = userQuery.match(/"value":"([^"]+)"/g)
          if (textMatches) {
            cleanQuery = textMatches
              .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
              .filter((text) => !text.startsWith("http")) // Remove URLs from query
              .join(" ")
              .trim()
          }
        }
      } catch (e) {
        cleanQuery = userQuery
      }

      return {
        queryRewrite: "",
        tool: "web_scraper",
        arguments: {
          urls: documentUrls,
          query:
            cleanQuery ||
            "Please extract and summarize the content from these URLs",
        },
        reasoning:
          "Attached document contains URLs - prioritizing web scraper to get content from document URLs",
      }
    } else {
      Logger.info(
        `[generateToolSelectionOutput] Attachment content found but no valid URLs extracted, trying alternative extraction`,
      )

      // Try more aggressive URL extraction from attachment content
      const attachmentOnlyContent = userContext.includes(
        "ATTACHED DOCUMENT CONTENT:",
      )
        ? userContext
            .split("ATTACHED DOCUMENT CONTENT:")[1]
            .split("USER CONTEXT:")[0]
        : userContext

      const alternativeUrls = extractUrlsFromText(attachmentOnlyContent)
      if (alternativeUrls.length > 0) {
        Logger.info(
          `[generateToolSelectionOutput] Alternative extraction found ${alternativeUrls.length} URLs`,
        )

        let cleanQuery = userQuery
        try {
          if (userQuery.includes('"type"') && userQuery.includes('"value"')) {
            const textMatches = userQuery.match(/"value":"([^"]+)"/g)
            if (textMatches) {
              cleanQuery = textMatches
                .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
                .filter((text) => !text.startsWith("http"))
                .join(" ")
                .trim()
            }
          }
        } catch (e) {
          cleanQuery = userQuery
        }

        return {
          queryRewrite: "",
          tool: "web_scraper",
          arguments: {
            urls: alternativeUrls,
            query:
              cleanQuery ||
              "Please extract and summarize the content from these URLs",
          },
          reasoning:
            "Found URLs in attachment content using alternative extraction - using web scraper",
        }
      }
    }
  } else {
    // Fallback: try extracting URLs from userContext even without attachment markers
    const documentUrls = extractUrlsFromText(userContext)
    if (documentUrls.length > 0) {
      Logger.info(
        `[generateToolSelectionOutput] FOUND ${documentUrls.length} URLs in userContext (no attachment markers) - PRIORITIZING web scraper`,
      )

      // Extract clean query text from userQuery if it contains structured data
      let cleanQuery = userQuery
      try {
        if (userQuery.includes('"type"') && userQuery.includes('"value"')) {
          const textMatches = userQuery.match(/"value":"([^"]+)"/g)
          if (textMatches) {
            cleanQuery = textMatches
              .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
              .filter((text) => !text.startsWith("http")) // Remove URLs from query
              .join(" ")
              .trim()
          }
        }
      } catch (e) {
        cleanQuery = userQuery
      }

      return {
        queryRewrite: "",
        tool: "web_scraper",
        arguments: {
          urls: documentUrls,
          query:
            cleanQuery ||
            "Please extract and summarize the content from these URLs",
        },
        reasoning:
          "Found URLs in user context - prioritizing web scraper to get content from URLs",
      }
    }
  }

  const { text, cost } = await getProviderByModel(params.modelId).converse(
    messages,
    params,
  )

  if (text) {
    // **PRIORITY 2: Check all available sources as fallback**
    const allText = `${userQuery} ${userContext} ${toolContext} ${initialPlanning}`
    const extractedUrls = extractUrlsFromText(allText)
    const hasUrls = extractedUrls.length > 0

    // Also check for URL indicators
    const hasUrlIndicators =
      allText.toLowerCase().includes("document contains urls") ||
      allText.toLowerCase().includes("link to") ||
      allText.toLowerCase().includes(".pdf") ||
      allText.toLowerCase().includes("tutorial") ||
      allText.toLowerCase().includes("read more") ||
      allText.toLowerCase().includes("webpage") ||
      allText.toLowerCase().includes("website") ||
      allText.toLowerCase().includes("http://") ||
      allText.toLowerCase().includes("https://")

    const needsWebScraping = hasUrls || hasUrlIndicators

    Logger.info(
      `[generateToolSelectionOutput] URL Analysis: extractedUrls=${extractedUrls.length}, hasUrls=${hasUrls}, hasUrlIndicators=${hasUrlIndicators}, needsWebScraping=${needsWebScraping}`,
    )

    // If we need web scraping but LLM didn't select it properly, force it
    if (needsWebScraping) {
      Logger.info("URLs detected - forcing web_scraper tool selection")

      if (extractedUrls.length > 0) {
        // Extract clean query text from userQuery if it contains structured data
        let cleanQuery = userQuery
        try {
          if (userQuery.includes('"type"') && userQuery.includes('"value"')) {
            const textMatches = userQuery.match(/"value":"([^"]+)"/g)
            if (textMatches) {
              cleanQuery = textMatches
                .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
                .filter((text) => !text.startsWith("http")) // Remove URLs from query
                .join(" ")
                .trim()
            }
          }
        } catch (e) {
          // Use original query if parsing fails
          cleanQuery = userQuery
        }

        return {
          queryRewrite: "",
          tool: "web_scraper",
          arguments: {
            urls: extractedUrls,
            query:
              cleanQuery ||
              "Please extract and summarize the content from these URLs",
          },
          reasoning:
            "Detected URLs in document content - using web scraper to get actual content",
        }
      } else {
        // Try to extract URLs again more aggressively or use fallback
        Logger.warn(
          "URL indicators found but no URLs extracted - attempting more aggressive extraction",
        )

        // Try broader patterns for URL-like content - only match actual URLs
        const broadUrlPatterns = [
          /https?:\/\/[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*/gi, // Only HTTP/HTTPS URLs
          /www\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*/gi, // Only www URLs
          /[a-zA-Z0-9.-]+\.(?:com|org|net|edu|gov|io|co\.uk|de|fr|jp|au|ca)\/[^\s]*/gi, // Common domains with paths
        ]

        let fallbackUrls: string[] = []
        for (const pattern of broadUrlPatterns) {
          const matches = allText.match(pattern)
          if (matches) {
            // Filter out email addresses before adding https://
            const validMatches = matches.filter((match) => !match.includes("@"))
            fallbackUrls.push(
              ...validMatches.map((url) =>
                url.startsWith("http") ? url : `https://${url}`,
              ),
            )
          }
        }

        // Clean and validate fallback URLs
        fallbackUrls = [...new Set(fallbackUrls)]
          .filter((url) => {
            try {
              // Skip anything that looks like an email address
              if (url.includes("@")) {
                return false
              }

              const urlObj = new URL(url)
              const hostname = urlObj.hostname.toLowerCase()

              // Filter out common email/system domains
              const isSystemDomain =
                hostname.includes("gmail") ||
                hostname.includes("mail.google") ||
                hostname.includes("outlook") ||
                hostname.includes("email") ||
                hostname.includes("unsubscribe")

              // Must be a valid URL with proper protocol
              const hasValidProtocol =
                urlObj.protocol === "http:" || urlObj.protocol === "https:"

              return !isSystemDomain && hasValidProtocol && hostname.length > 4
            } catch {
              return false
            }
          })
          .slice(0, 3)

        if (fallbackUrls.length > 0) {
          Logger.info(
            `[generateToolSelectionOutput] Using fallback URLs: ${JSON.stringify(fallbackUrls)}`,
          )

          // Extract clean query text
          let cleanQuery = userQuery
          try {
            if (userQuery.includes('"type"') && userQuery.includes('"value"')) {
              const textMatches = userQuery.match(/"value":"([^"]+)"/g)
              if (textMatches) {
                cleanQuery = textMatches
                  .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
                  .filter((text) => !text.startsWith("http"))
                  .join(" ")
                  .trim()
              }
            }
          } catch (e) {
            cleanQuery = userQuery
          }

          return {
            queryRewrite: "",
            tool: "web_scraper",
            arguments: {
              urls: fallbackUrls,
              query:
                cleanQuery ||
                "Please extract and summarize the content from these URLs",
            },
            reasoning:
              "Document indicates URL content available - using web scraper with extracted URLs",
          }
        } else {
          Logger.warn(
            "URL indicators found but no valid URLs could be extracted - falling back to search",
          )
          return {
            queryRewrite: userQuery,
            tool: "search",
            arguments: {},
            reasoning:
              "Document indicates external content but no valid URLs found - using search",
          }
        }
      }
    }

    // Normal LLM tool selection processing
    const jsonVal = jsonParseLLMOutput(text)
    if (!jsonVal) {
      Logger.warn(
        "Failed to parse tool selection output as JSON, falling back to conversational response",
      )
      return {
        queryRewrite: "",
        tool: "conversational",
        arguments: {},
        reasoning:
          "Failed to parse tool selection - using conversational fallback",
      }
    }

    // Validate that we have a valid tool name
    if (!jsonVal.tool || typeof jsonVal.tool !== "string") {
      Logger.warn(
        "Invalid or missing tool in LLM response, falling back to conversational",
      )
      return {
        queryRewrite: jsonVal.queryRewrite || "",
        tool: "conversational",
        arguments: {},
        reasoning: "Invalid tool selection - using conversational fallback",
      }
    }

    // If the LLM selected web_scraper but didn't provide URLs, try to extract them
    if (
      jsonVal.tool === "web_scraper" &&
      (!jsonVal.arguments?.urls || jsonVal.arguments.urls.length === 0)
    ) {
      Logger.info(
        "LLM selected web_scraper but no URLs provided, attempting to extract URLs from context",
      )

      if (extractedUrls.length > 0) {
        Logger.info(
          `[generateToolSelectionOutput] Extracted URLs for web_scraper: ${JSON.stringify(extractedUrls)}`,
        )

        // Extract clean query text
        let cleanQuery = userQuery
        try {
          if (userQuery.includes('"type"') && userQuery.includes('"value"')) {
            const textMatches = userQuery.match(/"value":"([^"]+)"/g)
            if (textMatches) {
              cleanQuery = textMatches
                .map((match) => match.replace(/"value":"([^"]+)"/, "$1"))
                .filter((text) => !text.startsWith("http"))
                .join(" ")
                .trim()
            }
          }
        } catch (e) {
          cleanQuery = userQuery
        }

        return {
          queryRewrite: jsonVal.queryRewrite || "",
          tool: "web_scraper",
          arguments: {
            urls: extractedUrls,
            query:
              cleanQuery ||
              "Please extract and summarize the content from these URLs",
          },
          reasoning:
            jsonVal.reasoning ||
            "LLM selected web_scraper, extracted URLs from context",
        }
      } else {
        // No URLs found, fallback to appropriate tool
        Logger.warn(
          "LLM selected web_scraper but no valid URLs could be extracted",
        )

        // Fall back to search
        return {
          queryRewrite: jsonVal.queryRewrite || userQuery,
          tool: "search",
          arguments: jsonVal.arguments || {},
          reasoning:
            "LLM selected web_scraper but no URLs available, falling back to search",
        }
      }
    }

    return {
      queryRewrite: jsonVal.queryRewrite || "",
      tool: jsonVal.tool,
      arguments: jsonVal.arguments || {},
      reasoning: jsonVal.reasoning || null,
    }
  } else {
    Logger.warn(
      "No response from LLM for tool selection, falling back to conversational response",
    )
    return {
      queryRewrite: "",
      tool: "conversational",
      arguments: {},
      reasoning: "No LLM response - using conversational fallback",
    }
  }
}

export function generateSearchQueryOrAnswerFromConversation(
  currentMessage: string,
  userContext: string,
  params: ModelParams,
  toolContext?: string,
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
      parseAgentPrompt(params.agentPrompt),
    )
  } else {
    params.systemPrompt = searchQueryPrompt(userContext)
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
      parsedAgentPrompt,
      fallbackReasoning,
    )
    params.systemPrompt = defaultSystemPrompt
  } else {
    params.systemPrompt = withToolQueryPrompt(
      userContext,
      toolContext,
      toolOutput,
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
      if (!parsedResponse) {
        Logger.warn(
          "Failed to parse fallback reasoning response as JSON, using raw text",
        )
        return {
          reasoning: text || "No reasoning provided",
          cost: cost!,
        }
      }
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
  names: Intent,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): Promise<{ emails: Intent }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }

  const intentNames =
    [
      ...(names.from?.length ? [`From: ${names.from.join(", ")}`] : []),
      ...(names.to?.length ? [`To: ${names.to.join(", ")}`] : []),
      ...(names.cc?.length ? [`CC: ${names.cc.join(", ")}`] : []),
      ...(names.bcc?.length ? [`BCC: ${names.bcc.join(", ")}`] : []),
    ].join(" | ") || "No names provided"

  params.systemPrompt = nameToEmailResolutionPrompt(
    userCtx,
    retrievedCtx,
    intentNames,
    names,
  )
  params.json = false

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `Help me find emails for these names: ${intentNames}`,
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
