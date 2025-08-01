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
} => {
  initializeProviders()
  if (
    !bedrockProvider &&
    !openaiProvider &&
    !ollamaProvider &&
    !togetherProvider &&
    !fireworksProvider &&
    !geminiProvider
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
