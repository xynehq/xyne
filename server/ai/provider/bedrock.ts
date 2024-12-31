import llama3Tokenizer from "llama3-tokenizer-js"
import ollama from "ollama"
import {
  BedrockRuntimeClient,
  ConversationRole,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  SystemContentBlock,
  type ConverseStreamMetadataEvent,
  type Message,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime"
import config from "@/config"
import { z } from "zod"
const { AwsAccessKey, AwsSecretKey, bedrockSupport, OpenAIKey } = config
import OpenAI from "openai"
import { getLogger } from "@/logger"
import { MessageRole, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { parse } from "partial-json"
import { modelDetailsMap, ModelToProviderMap } from "@/ai/mappers"
import type {
  AnswerResponse,
  ConverseResponse,
  Cost,
  ModelParams,
  QueryRouterResponse,
  TemporalClassifier,
} from "@/ai/types"
import {
  QueryContextRank,
  QueryAnalysisSchema,
  QueryRouterResponseSchema,
} from "@/ai/types"
import {
  analyzeInitialResultsOrRewriteSystemPrompt,
  analyzeInitialResultsOrRewriteV2SystemPrompt,
  AnalyzeUserQuerySystemPrompt,
  askQuestionUserPrompt,
  baselinePrompt,
  baselinePromptJson,
  chatWithCitationsSystemPrompt,
  generateMarkdownTableSystemPrompt,
  generateTitleSystemPrompt,
  metadataAnalysisSystemPrompt,
  optimizedPrompt,
  peopleQueryAnalysisSystemPrompt,
  queryRewritePromptJson,
  queryRouterPrompt,
  rewriteQuerySystemPrompt,
  searchQueryPrompt,
  temporalEventClassifier,
  userChatSystem,
} from "@/ai/prompts"
const Logger = getLogger(Subsystem.AI)

// TODO: Use enums from types file
export enum QueryCategory {
  Self = "Self",
  InternalPerson = "InternalPerson",
  ExternalPerson = "ExternalPerson",
  Other = "Other",
}

export enum Models {
  Llama_3_2_1B = "us.meta.llama3-2-1b-instruct-v1:0",
  Llama_3_2_3B = "us.meta.llama3-2-3b-instruct-v1:0",
  Llama_3_1_70B = "meta.llama3-1-70b-instruct-v1:0",
  Llama_3_1_8B = "meta.llama3-1-8b-instruct-v1:0",
  Llama_3_1_405B = "meta.llama3-1-405b-instruct-v1:0",
  // Bedrock_Claude = "",
  Gpt_4o = "gpt-4o",
  Gpt_4o_mini = "gpt-4o-mini",
  Gpt_4 = "gpt-4",

  CohereCmdRPlus = "cohere.command-r-plus-v1:0",
  CohereCmdR = "cohere.command-r-v1:0",
  Claude_3_5_SonnetV2 = "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  Claude_3_5_Sonnet = "anthropic.claude-3-5-sonnet-20240620-v1:0",
  Claude_3_5_Haiku = "anthropic.claude-3-5-haiku-20241022-v1:0",
  Amazon_Nova_Micro = "amazon.nova-micro-v1:0",
  Amazon_Nova_Lite = "amazon.nova-lite-v1:0",
  Amazon_Nova_Pro = "amazon.nova-pro-v1:0",
  Mistral_Large = "mistral.mistral-large-2402-v1:0",
}

export const calculateCost = (
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  cost: Cost,
): number => {
  const inputCost = (inputTokens / 1000) * cost.pricePerThousandInputTokens
  const outputCost = (outputTokens / 1000) * cost.pricePerThousandOutputTokens
  return inputCost + outputCost
}

const Oregon = "us-west-2"
const NVirginia = "us-east-1"
const FastModel = Models.Llama_3_1_70B

enum AIProviders {
  OpenAI = "openai",
  AwsBedrock = "bedrock",
  Ollama = "ollama",
}

interface LLMProvider {
  converseStream(
    messages: Message[],
    params?: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
  converseStream(
    messages: Message[],
    params?: ModelParams,
  ): AsyncIterableIterator<ConverseResponse>
  converse(messages: Message[], params?: ModelParams): Promise<ConverseResponse>
}

class Provider implements LLMProvider {
  private client: any
  private providerType: AIProviders
  constructor(client: any, providerType: AIProviders) {
    this.client = client
    this.providerType = providerType
  }

  async converse(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const modelParams = {
      maxTokens: params.max_new_tokens || 512,
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: params.modelId || FastModel,
      systemPrompt: params.systemPrompt || "You are a helpful assistant.",
      userCtx: params.userCtx,
      stream: false,
    }

    // Call the appropriate method based on provider type
    switch (this.providerType) {
      case AIProviders.OpenAI:
        return this.converseOpenAI(messages, modelParams)
      case AIProviders.AwsBedrock:
        return this.converseBedrock(messages, modelParams)
      case AIProviders.Ollama:
        return this.converseOllama(messages, modelParams)
      default:
        throw new Error(`Unsupported provider type: ${this.providerType}`)
    }
  }

  async *converseStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const modelParams = {
      maxTokens: params.max_new_tokens || 512,
      topP: params.top_p || 0.9,
      temperature: params.temperature || 0.6,
      modelId: params.modelId || FastModel,
      systemPrompt: params.systemPrompt || "You are a helpful assistant.",
      userCtx: params.userCtx,
      stream: params.stream,
    }

    // Call the appropriate method based on provider type
    switch (this.providerType) {
      case AIProviders.OpenAI:
        yield* this.converseOpenAIStream(messages, modelParams)
        break
      case AIProviders.AwsBedrock:
        yield* this.converseBedrockStream(messages, modelParams)
        break
      case AIProviders.Ollama:
        yield* this.converseOllamaStream(messages, modelParams)
        break
      default:
        throw new Error(`Unsupported provider type: ${this.providerType}`)
    }
  }

  private async *converseBedrockStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    const command = new ConverseStreamCommand({
      modelId: params.modelId,
      system: [
        {
          text: params.systemPrompt!,
        },
      ],
      messages: messages,
      inferenceConfig: {
        maxTokens: params.max_new_tokens || 512,
        topP: params.top_p || 0.9,
        temperature: params.temperature || 0.6,
      },
    })

    let modelId = params.modelId!
    try {
      const response = await this.client.send(command)

      if (response.stream) {
        for await (const chunk of response.stream) {
          const text = chunk.contentBlockDelta?.delta?.text
          const metadata = chunk.metadata
          let cost: number | undefined

          if (metadata?.usage) {
            const { inputTokens, outputTokens } = metadata.usage
            cost = calculateCost(
              { inputTokens: inputTokens!, outputTokens: outputTokens! },
              modelDetailsMap[modelId].cost.onDemand,
            )
          }
          yield {
            text,
            metadata,
            cost,
          }
        }
      }
    } catch (error) {
      console.error("Error in converseBedrock:", error)
      throw error
    }
  }

  private async *converseOllamaStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    // Placeholder for Ollama implementation
    throw new Error("Ollama provider is not implemented yet.")
  }
  private async *converseOpenAIStream(
    messages: Message[],
    params: ModelParams,
  ): AsyncIterableIterator<ConverseResponse> {
    // Placeholder for Ollama implementation
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
      messages: [
        {
          role: "system",
          content: params.systemPrompt!,
        },
        ...messages.map((v) => ({
          // @ts-ignore
          content: v.content[0].text!,
          role: v.role!,
        })),
      ],
      model: params.modelId,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.max_new_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
    })
    let cost: number | undefined
    for await (const chunk of chatCompletion) {
      if (chunk.usage) {
        cost = calculateCost(
          {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          },
          modelDetailsMap[params.modelId].cost.onDemand,
        )
      }
      if (chunk.choices && chunk.choices.length) {
        yield {
          text: chunk.choices[0].delta.content!,
          metadata: chunk.choices[0].finish_reason,
          cost,
        }
      } else {
        yield {
          text: "",
          metadata: "",
          cost,
        }
      }
    }
  }
  private async converseOllama(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    // Placeholder for Ollama implementation
    throw new Error("Ollama provider is not implemented yet.")
  }
  private async converseOpenAI(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const chatCompletion = await (
      this.client as OpenAI
    ).chat.completions.create({
      messages: [
        {
          role: "system",
          content: params.systemPrompt!,
        },
        ...messages.map((v) => ({
          // @ts-ignore
          content: v.content[0].text!,
          role: v.role!,
        })),
      ],
      model: params.modelId,
      stream: false,
      max_tokens: params.max_new_tokens,
      temperature: params.temperature,
      top_p: params.top_p,
      ...(params.json ? { response_format: { type: "json_object" } } : {}),
    })
    const fullResponse = chatCompletion.choices[0].message?.content || ""
    const cost = calculateCost(
      {
        inputTokens: chatCompletion.usage?.prompt_tokens!,
        outputTokens: chatCompletion.usage?.completion_tokens!,
      },
      modelDetailsMap[params.modelId].cost.onDemand,
    )
    return {
      text: fullResponse,
      cost,
    }
  }

  private async converseBedrock(
    messages: Message[],
    params: ModelParams,
  ): Promise<ConverseResponse> {
    const command = new ConverseCommand({
      modelId: params.modelId,
      system: [
        {
          text: params.systemPrompt!,
        },
      ],
      messages,
      inferenceConfig: {
        maxTokens: params.max_new_tokens || 512,
        topP: params.top_p || 0.9,
        temperature: params.temperature || 0,
      },
    })
    const response = await (this.client as BedrockRuntimeClient).send(command)
    if (!response) {
      throw new Error("Invalid bedrock response")
    }

    let fullResponse = response.output?.message?.content?.reduce(
      (prev: string, current) => {
        prev += current.text
        return prev
      },
      "",
    )
    if (!response.usage) {
      throw new Error("Could not get usage")
    }
    const { inputTokens, outputTokens } = response.usage
    return {
      text: fullResponse,
      cost: calculateCost(
        { inputTokens: inputTokens!, outputTokens: outputTokens! },
        modelDetailsMap[params.modelId].cost.onDemand,
      ),
    }
  }
}

const BigModel = Models.Llama_3_1_70B
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

const BedrockClient = new BedrockRuntimeClient({
  region: Oregon,
  credentials: {
    accessKeyId: AwsAccessKey,
    secretAccessKey: AwsSecretKey,
  },
})

const bedrockProvider = new Provider(BedrockClient, AIProviders.AwsBedrock)

const openAIClient = new OpenAI({
  apiKey: OpenAIKey,
})

const openaiProvider = new Provider(openAIClient, AIProviders.OpenAI)

// @ts-ignore
const ProviderMap: Record<AIProviders, LLMProvider> = {
  [AIProviders.AwsBedrock]: bedrockProvider,
  [AIProviders.OpenAI]: openaiProvider,

  // [AIProviders.Ollama]: openaiProvider,
}

const getProviderByModel = (modelId: Models): LLMProvider => {
  const providerType = ModelToProviderMap[modelId]
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
      params.modelId = BigModel
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
      params.modelId = FastModel
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

export const jsonParseLLMOutput = (text: string): any => {
  let jsonVal
  try {
    text = text.trim()
    // first it has to exist
    if (text.indexOf("{") !== -1) {
      if (text.indexOf("{") !== 0) {
        text = text.substring(text.indexOf("{"))
      }
    }
    if (text.lastIndexOf("}") !== -1) {
      if (text.lastIndexOf("}") !== text.length - 1) {
        text = text.substring(0, text.lastIndexOf("}") + 1)
      }
    }
    if (!text.trim()) {
      return ""
    }
    jsonVal = parse(text.trim())
  } catch (e) {
    try {
      text = text
        .replace(/```(json)?/g, "")
        .replace(/```/g, "")
        .replace(/\/\/.*$/gm, "")
        .trim()
      if (!text) {
        return ""
      }
      jsonVal = parse(text)
    } catch (parseError) {
      Logger.error(
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
    params.modelId = FastModel
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
      params.modelId = BigModel
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
      params.modelId = BigModel
    }

    if (!params.systemPrompt) {
      params.systemPrompt = generateTitleSystemPrompt
    }

    params.json = true

    const { text, cost } = await getProviderByModel(params.modelId).converse(
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
    params.modelId = FastModel
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
      params.modelId = BigModel
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
    params.modelId = FastModel
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
    params.modelId = FastModel
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
    params.modelId = FastModel
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

export const baselineRAGJsonStream = (
  userQuery: string,
  userCtx: string,
  retrievedCtx: string,
  params: ModelParams,
): AsyncIterableIterator<ConverseResponse> => {
  if (!params.modelId) {
    params.modelId = FastModel
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
    params.modelId = FastModel
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
    params.modelId = FastModel
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
  params.systemPrompt = searchQueryPrompt(userContext)

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
