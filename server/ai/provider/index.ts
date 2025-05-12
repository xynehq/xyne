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
  generateMarkdownTableSystemPrompt,
  generateTitleSystemPrompt,
  meetingPromptJson,
  metadataAnalysisSystemPrompt,
  optimizedPrompt,
  peopleQueryAnalysisSystemPrompt,
  queryRewritePromptJson,
  queryRouterPrompt,
  rewriteQuerySystemPrompt,
  searchQueryPrompt,
  searchQueryReasoningPrompt,
  temporalEventClassifier,
  userChatSystem,
} from "@/ai/prompts"
import { BedrockProvider } from "@/ai/provider/bedrock"
import { OpenAIProvider } from "@/ai/provider/openai"
import { Ollama } from "ollama"
import { OllamaProvider } from "@/ai/provider/ollama"
import Together from "together-ai"
import { TogetherProvider } from "@/ai/provider/together"
import { Fireworks } from "@/ai/provider/fireworksClient"
import { FireworksProvider } from "@/ai/provider/fireworks"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { GeminiAIProvider } from "@/ai/provider/gemini"
const Logger = getLogger(Subsystem.AI)

const askQuestionSystemPrompt =
  "You are a knowledgeable assistant that provides accurate and up-to-date answers based on the given context."

type TokenCount = number
// this will be a few tokens less than the output of bedrock
// the gap should be around 50 tokens
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
    const gemini = new GoogleGenerativeAI(GeminiApiKey)
    geminiProvider = new GeminiAIProvider(gemini)
  }

  if (!OpenAIKey && !TogetherApiKey && aiProviderBaseUrl) {
    Logger.warn(
      `Not using base_url: base_url is defined, but neither OpenAI nor Together API key was provided.`,
    )
  }
  providersInitialized = true
  // THIS IS WHERE :  this is where the creation of the provides goes using api key
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
    throw new Error("Invalid provider type")
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
    console.error("Error asking question:", error)
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
    console.error("Error analyzing query:", error)
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
    console.error("Error analyzing query:", error)
    throw error
  }
}

const nullCloseBraceRegex = /null\s*\n\s*\}/
export const jsonParseLLMOutput = (text: string, jsonKey?: string): any => {
  let jsonVal
  try {
    text = text.trim()
    // edge case "null\n} or ": "null\n}
    if (text.indexOf("{") === -1 && nullCloseBraceRegex.test(text)) {
      text = text.replaceAll(/[\n"}:`]/g, "")
    }
    // If the trimmed text does not start with '{' but contains jsonKey, wrap it in braces
    if (jsonKey && !text.startsWith("{") && text.includes(jsonKey)) {
      text = `{${text}`
    }
    const startBrace = text.indexOf("{")
    const endBrace = text.lastIndexOf("}")

    if (startBrace !== -1 || endBrace !== -1) {
      // there is no json
      if (startBrace !== -1) {
        if (startBrace !== 0) {
          text = text.substring(startBrace)
        }
      }
      if (endBrace !== -1) {
        // Only add the closing brace if it's not already there
        if (endBrace !== text.length - 1) {
          text = text.substring(0, endBrace + 1)
        }
      }
    }
    // we only want to do this if enough text has accumulated
    // we don't want to do case where just `json` comes and we wrap it as answer
    if (startBrace === -1 && jsonKey && text.length > 10) {
      if (text.trim() === "answer null" && jsonKey) {
        text = `{${jsonKey} null}`
      } else {
        text = `{${jsonKey} "${text}"`
      }
    }

    if (!text.trim()) {
      return ""
    }
    try {
      jsonVal = parse(text.trim())
      // If the object is empty but contains content, we explicitly add newline and carriage return characters (\\n).
      // This is necessary because the parsing library fails to handle multi-line strings properly,
      // returning an empty object when newlines are present in the content.
      if (Object.keys(jsonVal).length === 0 && text.length > 2) {
        // Replace newlines with \n in content between quotes
        const withNewLines = text.replace(/: "(.*?)"/gs, (match, content) => {
          const escaped = content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")
          return `: "${escaped}"`
        })
        jsonVal = parse(withNewLines.trim())
      }
      // edge case "null\n}
      if (jsonKey) {
        const key = jsonKey.slice(0, -1).replaceAll('"', "")
        if (jsonVal[key].trim() === "null") {
          jsonVal = { [key]: null }
        }
      }
      return jsonVal
    } catch {
      // If first parse failed, continue to code block cleanup
      throw new Error("Initial parse failed")
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
      throw parseError
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
    throw error
  }
}
export const generateTitleUsingQuery = async (
  query: string,
  params: ModelParams,
): Promise<{ title: string; cost: number }> => {
  try {
    if (!params.modelId) {
      params.modelId = defaultBestModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = generateTitleSystemPrompt
    }

    params.json = true

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
    if (isReasoning && text?.includes(EndThinkingToken)) {
      text = text?.split(EndThinkingToken)[1]
    }
    if (text) {
      const jsonVal = jsonParseLLMOutput(text)
      return {
        title: jsonVal.title,
        cost: cost!,
      }
    } else {
      throw new Error("Could not get json response")
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Error asking question: ${errMessage} ${(error as Error).stack}`,
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
    params.json = true // Ensure that the provider returns JSON
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
    throw error
  }
}

export const analyzeInitialResultsOrRewrite = (
  userQuery: string,
  context: string,
  userCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  params.systemPrompt = analyzeInitialResultsOrRewriteSystemPrompt(userCtx)

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
  params.systemPrompt = analyzeInitialResultsOrRewriteV2SystemPrompt(userCtx)

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

    params.systemPrompt = optimizedPrompt(userCtx)
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
    throw error
  }
}

// removing one op from prompt so we can figure out how to integrate this
// otherwise it conflicts with our current search system if we start
// talking about a single item

// 3. **RetrieveMetadata**:
//    - The user wants to retrieve metadata or details about a specific document, email, or item.
//    - Example Queries:
//      - "When was the file 'Budget.xlsx' last modified?"
//      - "Who owns the document titled 'Meeting Notes'?"
//    - **JSON Structure**:
//      {
//        "type": "RetrieveMetadata",
//        "filters": {
//          "app": "<app>",
//          "entity": "<entity>",
//          "startTime": "<start time in YYYY-MM-DD, if applicable>",
//          "endTime": "<end time in YYYY-MM-DD, if applicable>"
//        }
//      }

// // !this is under validation heading! not a prompt

//  - Ensure 'app' is only present in 'ListItems' and 'RetrieveMetadata' and is one of the enum values.
//  - Ensure 'entity' is only present in 'ListItems' and 'RetrieveMetadata' and is one of the enum values.

// Enums for Query Types, Apps, and Entities
export enum QueryType {
  RetrieveInformation = "RetrieveInformation",
  ListItems = "ListItems",
  // RetrieveMetadata = "RetrieveMetadata",
}

export const routeQuery = async (
  userQuery: string,
  params: ModelParams,
): Promise<{ result: QueryRouterResponse; cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  params.systemPrompt = queryRouterPrompt
  params.json = true

  const baseMessage = {
    role: ConversationRole.USER,
    content: [
      {
        text: `User Query: "${userQuery}"`,
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
      result: QueryRouterResponseSchema.parse(parsedResponse),
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

export const listItems = (
  query: string,
  userCtx: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  params.systemPrompt = generateMarkdownTableSystemPrompt(userCtx, query)
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
  params.systemPrompt = baselinePrompt(userCtx, retrievedCtx)
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
  params.systemPrompt = baselinePromptJson(userCtx, retrievedCtx)
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
    params.systemPrompt = baselineFilesContextPromptJson(
      userCtx,
      indexToCitation(retrievedCtx),
    )
  } else if (defaultReasoning) {
    // TODO: replace with reasoning specific prompt
    // clean retrieved context and turn Index <number> to just [<number>]
    // this is extra work because we just now set Index <number>
    // in future once the reasoning mode better supported we won't have to do this
    params.systemPrompt = baselineReasoningPromptJson(
      userCtx,
      indexToCitation(retrievedCtx),
    )
  } else {
    params.systemPrompt = baselinePromptJson(
      userCtx,
      indexToCitation(retrievedCtx),
    )
  }
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
  params.systemPrompt = queryRewritePromptJson(userCtx, retrievedCtx)
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
): Promise<TemporalClassifier & { cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  params.systemPrompt = temporalEventClassifier(userQuery)
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
      from: null,
      to: null,
      cost: cost!,
    }
  } else {
    throw new Error("No response from LLM")
  }
}

export function generateSearchQueryOrAnswerFromConversation(
  currentMessage: string,
  userContext: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> {
  //Promise<{ searchQuery: string, answer: string} & { cost: number }> {
  params.json = true
  let defaultReasoning = isReasoning

  if (params.reasoning !== undefined) {
    defaultReasoning = params.reasoning
  }
  if (defaultReasoning) {
    params.systemPrompt = searchQueryReasoningPrompt(userContext)
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
