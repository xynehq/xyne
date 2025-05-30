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
  emailPromptJson,
  generateMarkdownTableSystemPrompt,
  generateTitleSystemPrompt,
  metadataAnalysisSystemPrompt,
  optimizedPrompt,
  peopleQueryAnalysisSystemPrompt,
  queryRewritePromptJson,
  rewriteQuerySystemPrompt,
  searchQueryPrompt,
  searchQueryReasoningPrompt,
  temporalDirectionJsonPrompt,
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
import { agentAnalyzeInitialResultsOrRewriteSystemPrompt, agentAnalyzeInitialResultsOrRewriteV2SystemPrompt, agentBaselinePrompt, agentBaselinePromptJson, agentBaselineReasoningPromptJson, agentEmailPromptJson, agentGenerateMarkdownTableSystemPrompt, agentOptimizedPrompt, agentQueryRewritePromptJson, agentSearchQueryPrompt, agentTemporalDirectionJsonPrompt } from "../agentPrompts"
import { is } from "drizzle-orm"

const Logger = getLogger(Subsystem.AI)

// Interface for structured agent prompt data
interface AgentPromptData {
  prompt: string;
  sources: any[]; // Using any[] as the specific structure of sources isn't detailed
}

// Helper function to parse agentPrompt string into AgentPromptData object
function parseAgentPrompt(agentPromptString: string | undefined): AgentPromptData {
  if (!agentPromptString) {
    return { prompt: "", sources: [] };
  }

  try {
    const parsed = JSON.parse(agentPromptString);
    if (typeof parsed.prompt === 'string' && Array.isArray(parsed.sources)) {
      return {
        prompt: parsed.prompt,
        sources: parsed.sources,
      };
    }
    Logger.warn(`Agent prompt string did not match expected structure (prompt: string, sources: array). Treating as literal prompt: '${agentPromptString}'`);
    return { prompt: agentPromptString, sources: [] };
  } catch (error) {
    Logger.info(`Agent prompt string is not valid JSON. Treating as literal prompt: '${agentPromptString}'`);
    return { prompt: agentPromptString, sources: [] };
  }
}

// Helper function to check if the agent prompt string indicates empty prompt and sources
function isAgentPromptEmpty(agentPromptString: string | undefined): boolean {
  if (!agentPromptString || typeof agentPromptString !== 'string') {
    return false; // Or handle as an error, depending on expected behavior
  }
  try {
    const agentPromptObject = JSON.parse(agentPromptString);
    return (
      agentPromptObject.prompt === "" &&
      Array.isArray(agentPromptObject.sources) &&
      agentPromptObject.sources.length === 0
    );
  } catch (error) {
    Logger.error("Failed to parse agentPrompt JSON string in isAgentPromptEmpty:", error);
    return false; // Treat parse error as "not empty" or handle error appropriately
  }
}

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
  console.log(`[PROVIDER_LOG] Calling LLM for askQuestion`);
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
  console.log(`[PROVIDER_LOG] Calling LLM for analyzeQuery`);
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
  console.log(`[PROVIDER_LOG] Calling LLM for analyzeQueryMetadata`);
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
    // edge case where ```json is prepended to the text
    text = text.replace(/^```(json)?\s*/i, "")
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
    if (startBrace === -1 && jsonKey && text.trim() !== "json") {
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

      /* Edge case: If the last two characters are \\", Json.parse replaces \\ with ". We need to remove the last " from the value.
          Example:
          Input text: '{"answer": "Prasad \\""}'
          After JSON.parse: { answer: 'Prasad "' }  // Note the extra quote at the end
          After this fix: { answer: 'Prasad' }     // Extra quote removed
          
          This happens because: The original string has an escaped quote: \\".JSON.parse converts \\ to \ and " to ", resulting in an extra quote.
      */
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
  console.log(`[PROVIDER_LOG] Calling LLM for analyzeQueryForNamesAndEmails`);
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
  console.log(`[PROVIDER_LOG] Calling LLM for userChat`);
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
  console.log(`[PROVIDER_LOG] Calling LLM for analyzeInitialResultsOrRewrite`);
  if ( !isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentAnalyzeInitialResultsOrRewriteSystemPrompt")
    params.systemPrompt = agentAnalyzeInitialResultsOrRewriteSystemPrompt(userCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
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
  console.log(`[PROVIDER_LOG] Calling LLM for analyzeInitialResultsOrRewriteV2`);
  if ( !isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentAnalyzeInitialResultsOrRewriteV2SystemPrompt")
    params.systemPrompt = agentAnalyzeInitialResultsOrRewriteV2SystemPrompt(userCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
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
    console.log(`[PROVIDER_LOG] Calling LLM for answerOrSearch`);
    if ( !isAgentPromptEmpty(params.agentPrompt)) {
      console.log("Using agentOptimizedPrompt")
      params.systemPrompt = agentOptimizedPrompt(userCtx, parseAgentPrompt(params.agentPrompt))
    }
    else {
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
    throw error
  }
}

// Enums for Query Types, Apps, and Entities
export enum QueryType {
  RetrieveInformation = "RetrieveInformation",
  ListItems = "ListItems",
  // RetrieveMetadata = "RetrieveMetadata",
}

export const listItems = (
  query: string,
  userCtx: string,
  context: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  console.log(`[PROVIDER_LOG] Calling LLM for listItems`);
  if ( !isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentGenerateMarkdownTableSystemPrompt")
    params.systemPrompt = agentGenerateMarkdownTableSystemPrompt(userCtx, query,  parseAgentPrompt(params.agentPrompt))
  }
  else {
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
  console.log(`[PROVIDER_LOG] Calling LLM for baselineRAG`);
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentbaselinePrompt")
    params.systemPrompt = agentBaselinePrompt(userCtx, retrievedCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
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
  console.log(`[PROVIDER_LOG] Calling LLM for baselineRAGJson`);  
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentbaselinePromptJson")
    params.systemPrompt = agentBaselinePromptJson(userCtx,
    retrievedCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
    params.systemPrompt = baselinePromptJson(userCtx, retrievedCtx)
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
  console
  if (specificFiles) {
    Logger.info("Using baselineFilesContextPromptJson")
    params.systemPrompt = baselineFilesContextPromptJson(
      userCtx,
      indexToCitation(retrievedCtx),
    )
  } else if (defaultReasoning) {
    // TODO: replace with reasoning specific prompt
    // clean retrieved context and turn Index <number> to just [<number>]
    // this is extra work because we just now set Index <number>
    // in future once the reasoning mode better supported we won't have to do this
    Logger.info("Using baselineReasoningPromptJson")
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      console.log("Using agentbaselineReasoningPromptJson")
      params.systemPrompt = agentBaselineReasoningPromptJson(userCtx,
      indexToCitation(retrievedCtx), parseAgentPrompt(params.agentPrompt))
    } else {
      params.systemPrompt = baselineReasoningPromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
      )
    }
  } else {
    Logger.info("Using baselinePromptJson")
    
    if (!isAgentPromptEmpty(params.agentPrompt)) {
      console.log("Using agentbaselinePromptJson")
      params.systemPrompt = agentBaselinePromptJson(userCtx,
      indexToCitation(retrievedCtx), parseAgentPrompt(params.agentPrompt))
    } else {
      params.systemPrompt = baselinePromptJson(
        userCtx,
        indexToCitation(retrievedCtx),
      )
    }
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

export const temporalPromptJsonStream = (
  userQuery: string,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  console.log(`[PROVIDER_LOG] Calling LLM for temporalPromptJsonStream`);
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentTemporalDirectionJsonPrompt")
    params.systemPrompt = agentTemporalDirectionJsonPrompt(userCtx, retrievedCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
    params.systemPrompt = temporalDirectionJsonPrompt(userCtx, retrievedCtx)
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

export const mailPromptJsonStream = (
  userQuery: string,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  console.log(`[PROVIDER_LOG] Calling LLM for mailPromptJsonStream`);
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentEmailPromptJson")
    params.systemPrompt = agentEmailPromptJson(userCtx, retrievedCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
    params.systemPrompt = emailPromptJson(userCtx, retrievedCtx)
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
  console.log(`[PROVIDER_LOG] Calling LLM for queryRewriter`);
  if (!isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentQueryRewritePromptJson")
    params.systemPrompt = agentQueryRewritePromptJson(userCtx, parseAgentPrompt(params.agentPrompt))
  }
  else {
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
): Promise<Omit<TemporalClassifier, "filter_query"> & { cost: number }> => {
  if (!params.modelId) {
    params.modelId = defaultFastModel
  }
  // params.systemPrompt = temporalEventClassifier(userQuery)
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
  console.log(`[PROVIDER_LOG] Calling LLM for generateSearchQueryOrAnswerFromConversation`);
  if (defaultReasoning) {
    params.systemPrompt = searchQueryReasoningPrompt(userContext)
  } else if (!isAgentPromptEmpty(params.agentPrompt)) {
    console.log("Using agentSearchQueryPrompt", params.agentPrompt)
    params.systemPrompt = agentSearchQueryPrompt(userContext, parseAgentPrompt(params.agentPrompt))
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
