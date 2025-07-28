import { type Message } from "@aws-sdk/client-bedrock-runtime"
import { z } from "zod"
import { Apps, entitySchema } from "@/search/types"

export enum AIProviders {
  OpenAI = "openai",
  AwsBedrock = "bedrock",
  Ollama = "ollama",
  Together = "together-ai",
  Fireworks = "fireworks",
  GoogleAI = "google-ai",
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
  Gemini_2_5_Flash = "gemini-2.5-flash",
  Gemini_2_0_Flash_Thinking = "gemini-2.0-flash-thinking-exp",
}

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
}

export interface ConverseResponse {
  text?: string
  metadata?: any
  cost?: number
  reasoning?: boolean
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
  offset: z.preprocess((val) => (val == null ? 0 : val), z.number()),
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

export interface ChainBreakClassifications {
  availableChainBreaks: Array<{
    chainIndex: number;
    messageIndex: number;
    originalQuery: string;
    classification: QueryRouterLLMResponse;
  }>;
  usage: string;
}

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
