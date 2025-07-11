import { z } from "zod"
import { Apps, entitySchema } from "./search-types"
import { type Message } from "@aws-sdk/client-bedrock-runtime"

export enum AIProviders {
  OpenAI = "openai",
  AwsBedrock = "bedrock",
  Ollama = "ollama",
  Together = "together-ai",
  Fireworks = "fireworks",
  GoogleAI = "google-ai",
  AzureOpenAI = "azure-openai",
  OpenRouter = "openrouter",
  VertexAI = "VertexAI",
}

/*export enum Models {
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
  Claude_3_7_Sonnet = "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  Claude_3_5_Sonnet = "anthropic.claude-3-5-sonnet-20240620-v1:0",
  Claude_3_5_Haiku = "anthropic.claude-3-5-haiku-20241022-v1:0",
  Claude_Opus_4 = "us.anthropic.claude-opus-4-20250514-v1:0",
  Claude_Sonnet_4 = "us.anthropic.claude-sonnet-4-20250514-v1:0",
  Amazon_Nova_Micro = "amazon.nova-micro-v1:0",
  Amazon_Nova_Lite = "amazon.nova-lite-v1:0",
  Amazon_Nova_Pro = "amazon.nova-pro-v1:0",

  DeepSeek_R1 = "us.deepseek.r1-v1:0",
  Mistral_Large = "mistral.mistral-large-2402-v1:0",
}*/

export enum QueryCategory {
  Self = "Self",
  InternalPerson = "InternalPerson",
  ExternalPerson = "ExternalPerson",
  Other = "Other",
}

// Enums for Query Types, Apps, and Entities
export enum QueryType {
  SearchWithoutFilters = "SearchWithoutFilters",
  GetItems = "GetItems",
  SearchWithFilters = "SearchWithFilters",
}

export type Cost = {
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}

export type TimeDirection = "next" | "prev" | null
export interface TemporalClassifier {
  direction: TimeDirection | null
  filterQuery: string | null
}

export interface ModelParams {
  max_new_tokens?: number
  top_p?: number
  temperature?: number
  modelId: Models
  systemPrompt?: string
  userCtx?: string
  stream: boolean
  json?: boolean
  messages?: Message[]
  reasoning?: boolean
  prompt?: string
  agentPrompt?: string
  imageFileNames?: string[]
  maxTokens?: number
  topP?: number
}

export interface ConverseResponse {
  text?: string
  metadata?: any
  cost?: number
  reasoning?: boolean
  isComplete?: boolean
}

export interface LLMProvider {
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

export interface AnswerResponse {
  answer: string | null
}

export const QueryAnalysisSchema = z.object({
  category: z.nativeEnum(QueryCategory),
  mentionedNames: z.array(z.string()),
  mentionedEmails: z.array(z.string()),
})

export type QueryAnalysisResult = z.infer<typeof QueryAnalysisSchema>

export const initialResultsOrRewriteSchema = z.object({
  answer: z.string().optional(),
  citations: z.array(z.number()),
  rewrittenQueries: z.array(z.string()).optional(),
})

export type ResultsOrRewrite = z.infer<typeof initialResultsOrRewriteSchema>

export const SearchAnswerResponse = z.object({
  answer: z.string().nullable(),
  citations: z.array(z.number()).nullable(),
  searchQueries: z.array(z.string()),
  usefulIndex: z.array(z.number()),
})

export const ToolAnswerResponse = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.any()).optional(),
})

// Intent Schema - only includes fields with actual values (modular for different apps)
export const IntentSchema = z.object({
  from: z.array(z.string()).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
})

export type Intent = z.infer<typeof IntentSchema>

// Zod schemas for filters
export const FiltersSchema = z.object({
  app: z.nativeEnum(Apps).optional(),
  entity: entitySchema.optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  sortDirection: z.string().optional(),
  count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
  intent: IntentSchema.optional(),
})

const TemporalClassifierSchema = z.object({
  direction: z.union([z.literal("prev"), z.literal("next")]).nullable(),
})

export const GetItems = z
  .object({
    type: z.literal(QueryType.GetItems),
    isFollowUp: z.boolean().optional(),
    filters: FiltersSchema,
    filterQuery: z.string().nullable(),
  })
  .merge(TemporalClassifierSchema)

export const SearchWithFilters = z
  .object({
    type: z.literal(QueryType.SearchWithFilters),
    isFollowUp: z.boolean().optional(),
    filters: FiltersSchema,
    filterQuery: z.string().nullable(),
  })
  .merge(TemporalClassifierSchema)

export const QueryRouterResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(QueryType.SearchWithoutFilters),
      isFollowUp: z.boolean().optional(),
      filters: FiltersSchema,
      filterQuery: z.string().nullable(),
    })
    .merge(TemporalClassifierSchema),
  SearchWithFilters,
  GetItems,
])

export type QueryRouterLLMResponse = z.infer<typeof QueryRouterResponseSchema>

export const QueryContextRank = z.object({
  canBeAnswered: z.boolean(),
  contextualChunks: z.array(z.number()),
})

export type QueryContextRank = z.infer<typeof QueryContextRank>

export type QueryRouterResponse = z.infer<typeof QueryRouterResponseSchema>

interface TextQueryItem {
  type: "text"
  value: string
}

interface PillValue {
  title: string
  docId: string
  threadId?: string
  app?: Apps
}

interface PillQueryItem {
  type: "pill"
  value: PillValue
}

interface LinkQueryItem {
  type: "link"
  value: string
}

type UserQueryItem = TextQueryItem | PillQueryItem | LinkQueryItem

export type UserQuery = UserQueryItem[]

export enum Models {
  Claude_3_Haiku = "claude-3-haiku-20240307",
  Claude_3_Opus = "claude-3-opus-20240229",
  GPT_4o = "gpt-4o",
  GPT_4o_Mini = "gpt-4o-mini",
  GPT_4_1 = "gpt-4.1",
  O1_Preview = "o1-preview",
  O1_Mini = "o1-mini",
  Azure_GPT_4o = "azure-gpt-4o",
  Azure_GPT_4o_Mini = "azure-gpt-4o-mini",
  Azure_GPT_4_Turbo = "azure-gpt-4-turbo",
  Azure_GPT_35_Turbo = "azure-gpt-3.5-turbo",
  Gemini_2_5_Flash = "gemini-2.5-flash",
  Gemini_2_5_Flash_Preview = "gemini-2.5-flash-preview-05-20",
  Gemini_2_5_Pro_Preview = "gemini-2.5-pro-preview-06-05",
  Gemini_2_0_Flash_Exp = "gemini-2.0-flash",
  Gemini_1_5_Pro = "gemini-1.5-pro",
  Gemini_1_5_Flash = "gemini-1.5-flash",
  // Vertex AI Models (Claude and Gemini) - Matching Cline model IDs
  Vertex_Claude_Sonnet_4 = "claude-sonnet-4@20250514",
  Vertex_Claude_3_5_Sonnet_V2 = "claude-3-5-sonnet-v2@20241022",
  Vertex_Claude_3_5_Sonnet = "claude-3-5-sonnet@20240620",
  Vertex_Claude_3_5_Haiku = "claude-3-5-haiku@20241022",
  Vertex_Claude_3_Opus = "claude-3-opus@20240229",
  Vertex_Claude_3_Haiku = "claude-3-haiku@20240307",
  Vertex_Gemini_2_0_Flash = "gemini-2.0-flash-exp",
  Vertex_Gemini_1_5_Pro = "gemini-1.5-pro-002",
  Vertex_Gemini_1_5_Flash = "gemini-1.5-flash-002",
  // OpenRouter Models (Popular models from various providers)
  OpenRouter_Claude_3_5_Sonnet = "anthropic/claude-3.5-sonnet",
  OpenRouter_Claude_3_5_Haiku = "anthropic/claude-3.5-haiku",
  OpenRouter_Claude_3_Opus = "anthropic/claude-3-opus",
  OpenRouter_GPT_4o = "openai/gpt-4o",
  OpenRouter_GPT_4o_Mini = "openai/gpt-4o-mini",
  OpenRouter_O1_Preview = "openai/o1-preview",
  OpenRouter_O1_Mini = "openai/o1-mini",
  OpenRouter_Gemini_2_0_Flash = "google/gemini-2.0-flash-exp",
  OpenRouter_Gemini_1_5_Pro = "google/gemini-pro-1.5",
  OpenRouter_Llama_3_1_405B = "meta-llama/llama-3.1-405b-instruct",
  OpenRouter_Llama_3_1_70B = "meta-llama/llama-3.1-70b-instruct",
  OpenRouter_Qwen_2_5_72B = "qwen/qwen-2.5-72b-instruct",
  OpenRouter_DeepSeek_V3 = "deepseek/deepseek-chat",
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
  Claude_3_7_Sonnet = "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  Claude_3_5_Sonnet = "anthropic.claude-3-5-sonnet-20240620-v1:0",
  Claude_3_5_Haiku = "anthropic.claude-3-5-haiku-20241022-v1:0",
  Claude_Opus_4 = "us.anthropic.claude-opus-4-20250514-v1:0",
  Claude_Sonnet_4 = "us.anthropic.claude-sonnet-4-20250514-v1:0",
  Amazon_Nova_Micro = "amazon.nova-micro-v1:0",
  Amazon_Nova_Lite = "amazon.nova-lite-v1:0",
  Amazon_Nova_Pro = "amazon.nova-pro-v1:0",

  DeepSeek_R1 = "us.deepseek.r1-v1:0",
  Mistral_Large = "mistral.mistral-large-2402-v1:0",
}
