import { type Message } from "@aws-sdk/client-bedrock-runtime"
import { z } from "zod"
import { Apps } from "@xyne/vespa-ts/types"
import { entitySchema } from "@/shared/types"

export enum AIProviders {
  OpenAI = "openai",
  AwsBedrock = "bedrock",
  Ollama = "ollama",
  Together = "together-ai",
  Fireworks = "fireworks",
  GoogleAI = "google-ai",
  VertexAI = "vertex-ai",
}

// Sub-provider specific model enums
export enum AwsBedrockModels {
  // Claude Models
  Claude_3_5_Haiku = "aws-claude-3-5-haiku",
  Claude_3_5_Sonnet = "aws-claude-3-5-sonnet",
  Claude_3_5_SonnetV2 = "aws-claude-3-5-sonnet-v2",
  Claude_3_7_Sonnet = "aws-claude-3-7-sonnet",
  Claude_Opus_4 = "aws-claude-opus-4",
  Claude_Sonnet_4 = "aws-claude-sonnet-4",

  // Llama Models
  Llama_3_1_405B = "aws-llama-3-1-405b",
  Llama_3_1_70B = "aws-llama-3-1-70b",
  Llama_3_1_8B = "aws-llama-3-1-8b",
  Llama_3_2_1B = "aws-llama-3-2-1b",
  Llama_3_2_3B = "aws-llama-3-2-3b",

  // Amazon Nova Models
  Amazon_Nova_Micro = "aws-nova-micro",
  Amazon_Nova_Lite = "aws-nova-lite",
  Amazon_Nova_Pro = "aws-nova-pro",

  // Cohere Models
  CohereCmdR = "aws-cohere-cmd-r",
  CohereCmdRPlus = "aws-cohere-cmd-r-plus",

  // Other Models
  DeepSeek_R1 = "aws-deepseek-r1",
  Mistral_Large = "aws-mistral-large",
}

export enum OpenAIModels {
  Gpt_4o = "gpt-4o",
  Gpt_4o_mini = "gpt-4o-mini",
  Gpt_4 = "gpt-4",
  o3_Deep_Research = "o3-deep-research",
  o4_Mini_Deep_Research = "o4-mini-deep-research",
}

export enum GoogleAIModels {
  Gemini_2_5_Flash = "googleai-gemini-2-5-flash",
  Gemini_2_0_Flash_Thinking = "googleai-gemini-2-0-flash-thinking",
}

export enum VertexAIModels {
  // Claude Models (different from AWS Bedrock)
  Claude_Sonnet_4 = "vertex-claude-sonnet-4",
  // Claude_Opus_4_1 = "vertex-claude-opus-4-1",
  // Claude_Opus_4 = "vertex-claude-opus-4",
  Claude_3_7_Sonnet = "vertex-claude-3-7-sonnet",
  // Claude_3_5_Sonnet_V2 = "vertex-claude-3-5-sonnet-v2",
  Claude_3_5_Sonnet = "vertex-claude-3-5-sonnet",
  // Claude_3_5_Haiku = "vertex-claude-3-5-haiku",
  // Claude_3_Opus = "vertex-claude-3-opus",
  // Claude_3_Haiku = "vertex-claude-3-haiku",

  // Mistral Models
  // Mistral_Large_2411 = "vertex-mistral-large-2411",
  // Mistral_Small_2503 = "vertex-mistral-small-2503",
  // Codestral_2501 = "vertex-codestral-2501",

  // Llama Models
  // Llama_4_Maverick_17b = "vertex-llama-4-maverick-17b",
  // Llama_4_Scout_17b = "vertex-llama-4-scout-17b",

  // Gemini Models (different from Google AI)
  // Gemini_2_0_Flash_001 = "vertex-gemini-2-0-flash-001", // Flash 2.0
  // Gemini_2_0_Flash_Lite_001 = "vertex-gemini-2-0-flash-lite-001", // Flash Lite 2.0
  // Gemini_2_0_Flash_Thinking_Exp_1219 = "vertex-gemini-2-0-flash-thinking-exp-1219",
  // Gemini_2_0_Flash_Exp = "vertex-gemini-2-0-flash-exp",
  // Gemini_2_5_Pro_Exp_03_25 = "vertex-gemini-2-5-pro-exp-03-25",
  Gemini_2_5_Pro = "vertex-gemini-2-5-pro", // 2.5 Pro
  Gemini_2_5_Flash = "vertex-gemini-2-5-flash", // 2.5 Flash
  // Gemini_2_5_Flash_Lite_Preview = "vertex-gemini-2-5-flash-lite-preview",
  // Gemini_2_0_Flash_Thinking_Exp_01_21 = "vertex-gemini-2-0-flash-thinking-exp-01-21",
  // Gemini_Exp_1206 = "vertex-gemini-exp-1206",
  // Gemini_1_5_Flash_002 = "vertex-gemini-1-5-flash-002",
  // Gemini_1_5_Flash_Exp_0827 = "vertex-gemini-1-5-flash-exp-0827",
  // Gemini_1_5_Flash_8b_Exp_0827 = "vertex-gemini-1-5-flash-8b-exp-0827",
  // Gemini_1_5_Pro_002 = "vertex-gemini-1-5-pro-002",
  // Gemini_1_5_Pro_Exp_0827 = "vertex-gemini-1-5-pro-exp-0827",
}

// Unified Models enum that includes all provider models
export enum Models {
  // AWS Bedrock Models
  Claude_3_5_Haiku = AwsBedrockModels.Claude_3_5_Haiku,
  Claude_3_5_Sonnet = AwsBedrockModels.Claude_3_5_Sonnet,
  Claude_3_5_SonnetV2 = AwsBedrockModels.Claude_3_5_SonnetV2,
  Claude_3_7_Sonnet = AwsBedrockModels.Claude_3_7_Sonnet,
  Claude_Opus_4 = AwsBedrockModels.Claude_Opus_4,
  Claude_Sonnet_4 = AwsBedrockModels.Claude_Sonnet_4,
  Llama_3_1_405B = AwsBedrockModels.Llama_3_1_405B,
  Llama_3_1_70B = AwsBedrockModels.Llama_3_1_70B,
  Llama_3_1_8B = AwsBedrockModels.Llama_3_1_8B,
  Llama_3_2_1B = AwsBedrockModels.Llama_3_2_1B,
  Llama_3_2_3B = AwsBedrockModels.Llama_3_2_3B,
  Amazon_Nova_Micro = AwsBedrockModels.Amazon_Nova_Micro,
  Amazon_Nova_Lite = AwsBedrockModels.Amazon_Nova_Lite,
  Amazon_Nova_Pro = AwsBedrockModels.Amazon_Nova_Pro,
  CohereCmdR = AwsBedrockModels.CohereCmdR,
  CohereCmdRPlus = AwsBedrockModels.CohereCmdRPlus,
  DeepSeek_R1 = AwsBedrockModels.DeepSeek_R1,
  Mistral_Large = AwsBedrockModels.Mistral_Large,

  // OpenAI Models
  Gpt_4o = OpenAIModels.Gpt_4o,
  Gpt_4o_mini = OpenAIModels.Gpt_4o_mini,
  Gpt_4 = OpenAIModels.Gpt_4,
  o3_Deep_Research = OpenAIModels.o3_Deep_Research,
  o4_Mini_Deep_Research = OpenAIModels.o4_Mini_Deep_Research,

  // Google AI Models
  Gemini_2_5_Flash = GoogleAIModels.Gemini_2_5_Flash,
  Gemini_2_0_Flash_Thinking = GoogleAIModels.Gemini_2_0_Flash_Thinking,

  // Vertex AI Models
  Vertex_Claude_Sonnet_4 = VertexAIModels.Claude_Sonnet_4,
  // Vertex_Claude_Opus_4_1 = VertexAIModels.Claude_Opus_4_1,
  // Vertex_Claude_Opus_4 = VertexAIModels.Claude_Opus_4,
  // Vertex_Claude_3_7_Sonnet = VertexAIModels.Claude_3_7_Sonnet,
  // Vertex_Claude_3_5_Sonnet_V2 = VertexAIModels.Claude_3_5_Sonnet_V2,
  // Vertex_Claude_3_5_Sonnet = VertexAIModels.Claude_3_5_Sonnet,
  // Vertex_Claude_3_5_Haiku = VertexAIModels.Claude_3_5_Haiku,
  // Vertex_Claude_3_Opus = VertexAIModels.Claude_3_Opus,
  // Vertex_Claude_3_Haiku = VertexAIModels.Claude_3_Haiku,
  // Vertex_Mistral_Large_2411 = VertexAIModels.Mistral_Large_2411,
  // Vertex_Mistral_Small_2503 = VertexAIModels.Mistral_Small_2503,
  // Vertex_Codestral_2501 = VertexAIModels.Codestral_2501,
  // Vertex_Llama_4_Maverick_17b = VertexAIModels.Llama_4_Maverick_17b,
  // Vertex_Llama_4_Scout_17b = VertexAIModels.Llama_4_Scout_17b,
  // Vertex_Gemini_2_0_Flash_001 = VertexAIModels.Gemini_2_0_Flash_001,
  // Vertex_Gemini_2_0_Flash_Lite_001 = VertexAIModels.Gemini_2_0_Flash_Lite_001,
  // Vertex_Gemini_2_0_Flash_Thinking_Exp_1219 = VertexAIModels.Gemini_2_0_Flash_Thinking_Exp_1219,
  // Vertex_Gemini_2_0_Flash_Exp = VertexAIModels.Gemini_2_0_Flash_Exp,
  // Vertex_Gemini_2_5_Pro_Exp_03_25 = VertexAIModels.Gemini_2_5_Pro_Exp_03_25,
  Vertex_Gemini_2_5_Pro = VertexAIModels.Gemini_2_5_Pro,
  Vertex_Gemini_2_5_Flash = VertexAIModels.Gemini_2_5_Flash,
  // Vertex_Gemini_2_5_Flash_Lite_Preview = VertexAIModels.Gemini_2_5_Flash_Lite_Preview,
  // Vertex_Gemini_2_0_Flash_Thinking_Exp_01_21 = VertexAIModels.Gemini_2_0_Flash_Thinking_Exp_01_21,
  // Vertex_Gemini_Exp_1206 = VertexAIModels.Gemini_Exp_1206,
  // Vertex_Gemini_1_5_Flash_002 = VertexAIModels.Gemini_1_5_Flash_002,
  // Vertex_Gemini_1_5_Flash_Exp_0827 = VertexAIModels.Gemini_1_5_Flash_Exp_0827,
  // Vertex_Gemini_1_5_Flash_8b_Exp_0827 = VertexAIModels.Gemini_1_5_Flash_8b_Exp_0827,
  // Vertex_Gemini_1_5_Pro_002 = VertexAIModels.Gemini_1_5_Pro_002,
  // Vertex_Gemini_1_5_Pro_Exp_0827 = VertexAIModels.Gemini_1_5_Pro_Exp_0827,
}

// Model availability mapping - which providers support which models
export const ModelProviderAvailability: Record<string, AIProviders[]> = {
  // Models available in multiple providers (but with different identifiers)
  "Claude 3.5 Haiku": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude 3.5 Sonnet": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude 3.5 Sonnet V2": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude 3.7 Sonnet": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude Opus 4": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Claude Sonnet 4": [AIProviders.AwsBedrock, AIProviders.VertexAI],
  "Gemini 2.5 Flash": [AIProviders.GoogleAI, AIProviders.VertexAI],

  // Provider-specific models
  "Llama 3.1 405B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.1 70B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.1 8B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.2 1B Instruct": [AIProviders.AwsBedrock],
  "Llama 3.2 3B Instruct": [AIProviders.AwsBedrock],
  "Amazon Nova Micro": [AIProviders.AwsBedrock],
  "Amazon Nova Lite": [AIProviders.AwsBedrock],
  "Amazon Nova Pro": [AIProviders.AwsBedrock],
  "Cohere Command R": [AIProviders.AwsBedrock],
  "Cohere Command R+": [AIProviders.AwsBedrock],
  "DeepSeek R1": [AIProviders.AwsBedrock],
  "Mistral Large": [AIProviders.AwsBedrock],
  "GPT-4o": [AIProviders.OpenAI],
  "GPT-4o Mini": [AIProviders.OpenAI],
  "GPT-4": [AIProviders.OpenAI],
  "Gemini 2.0 Flash Thinking": [AIProviders.GoogleAI],
}

// Model display names enum - proper enum instead of string to string mapping
export enum ModelDisplayNames {
  // AWS Bedrock Models
  AWS_CLAUDE_3_5_HAIKU = "Claude 3.5 Haiku",
  AWS_CLAUDE_3_5_SONNET = "Claude 3.5 Sonnet",
  AWS_CLAUDE_3_5_SONNET_V2 = "Claude 3.5 Sonnet V2",
  AWS_CLAUDE_3_7_SONNET = "Claude 3.7 Sonnet",
  AWS_CLAUDE_OPUS_4 = "Claude Opus 4",
  AWS_CLAUDE_SONNET_4 = "Claude Sonnet 4",
  AWS_LLAMA_3_1_405B = "Llama 3.1 405B Instruct",
  AWS_LLAMA_3_1_70B = "Llama 3.1 70B Instruct",
  AWS_LLAMA_3_1_8B = "Llama 3.1 8B Instruct",
  AWS_LLAMA_3_2_1B = "Llama 3.2 1B Instruct",
  AWS_LLAMA_3_2_3B = "Llama 3.2 3B Instruct",
  AWS_AMAZON_NOVA_MICRO = "Amazon Nova Micro",
  AWS_AMAZON_NOVA_LITE = "Amazon Nova Lite",
  AWS_AMAZON_NOVA_PRO = "Amazon Nova Pro",
  AWS_COHERE_CMD_R = "Cohere Command R",
  AWS_COHERE_CMD_R_PLUS = "Cohere Command R+",
  AWS_DEEPSEEK_R1 = "DeepSeek R1",
  AWS_MISTRAL_LARGE = "Mistral Large",

  // OpenAI Models
  OPENAI_GPT_4O = "GPT-4o",
  OPENAI_GPT_4O_MINI = "GPT-4o Mini",
  OPENAI_GPT_4 = "GPT-4",
  OPENAI_o3_DEEP_RESEARCH = "o3 Deep Research",
  OPENAI_o4_MINI_DEEP_RESEARCH = "o4 Mini Deep Research",

  // Google AI Models
  GOOGLEAI_GEMINI_2_5_FLASH = "Gemini 2.5 Flash",
  GOOGLEAI_GEMINI_2_0_FLASH_THINKING = "Gemini 2.0 Flash Thinking",

  // Vertex AI Models
  VERTEX_CLAUDE_SONNET_4 = "Claude Sonnet 4",
  // VERTEX_CLAUDE_OPUS_4_1 = "Claude Opus 4.1",
  // VERTEX_CLAUDE_OPUS_4 = "Claude Opus 4",
  // VERTEX_CLAUDE_3_7_SONNET = "Claude 3.7 Sonnet",
  // VERTEX_CLAUDE_3_5_SONNET_V2 = "Claude 3.5 Sonnet V2",
  // VERTEX_CLAUDE_3_5_SONNET = "Claude 3.5 Sonnet",
  // VERTEX_CLAUDE_3_5_HAIKU = "Claude 3.5 Haiku",
  // VERTEX_CLAUDE_3_OPUS = "Claude 3 Opus",
  // VERTEX_CLAUDE_3_HAIKU = "Claude 3 Haiku",
  // VERTEX_MISTRAL_LARGE_2411 = "Mistral Large 2411",
  // VERTEX_MISTRAL_SMALL_2503 = "Mistral Small 2503",
  // VERTEX_CODESTRAL_2501 = "Codestral 2501",
  // VERTEX_LLAMA_4_MAVERICK_17B = "Llama 4 Maverick 17B",
  // VERTEX_LLAMA_4_SCOUT_17B = "Llama 4 Scout 17B",
  // VERTEX_GEMINI_2_0_FLASH_001 = "Gemini 2.0 Flash 001", // Flash 2.0
  // VERTEX_GEMINI_2_0_FLASH_LITE_001 = "Gemini 2.0 Flash Lite 001", // Flash Lite 2.0
  // VERTEX_GEMINI_2_0_FLASH_THINKING_EXP_1219 = "Gemini 2.0 Flash Thinking Exp 1219",
  // VERTEX_GEMINI_2_0_FLASH_EXP = "Gemini 2.0 Flash Exp",
  // VERTEX_GEMINI_2_5_PRO_EXP_03_25 = "Gemini 2.5 Pro Exp 03-25",
  VERTEX_GEMINI_2_5_PRO = "Gemini 2.5 Pro", // 2.5 Pro
  VERTEX_GEMINI_2_5_FLASH = "Gemini 2.5 Flash", // 2.5 Flash
  // VERTEX_GEMINI_2_5_FLASH_LITE_PREVIEW = "Gemini 2.5 Flash Lite Preview",
  // VERTEX_GEMINI_2_0_FLASH_THINKING_EXP_01_21 = "Gemini 2.0 Flash Thinking Exp 01-21",
  // VERTEX_GEMINI_EXP_1206 = "Gemini Exp 1206",
  // VERTEX_GEMINI_1_5_FLASH_002 = "Gemini 1.5 Flash 002",
  // VERTEX_GEMINI_1_5_FLASH_EXP_0827 = "Gemini 1.5 Flash Exp 0827",
  // VERTEX_GEMINI_1_5_FLASH_8B_EXP_0827 = "Gemini 1.5 Flash 8B Exp 0827",
  // VERTEX_GEMINI_1_5_PRO_002 = "Gemini 1.5 Pro 002",
  // VERTEX_GEMINI_1_5_PRO_EXP_0827 = "Gemini 1.5 Pro Exp 0827",
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
  // Tool calling (optional)
  tools?: Array<{
    name: string
    description?: string
    parameters?: any
  }>
  tool_choice?: "auto" | "none" | "required"
  parallel_tool_calls?: boolean
  webSearch?: boolean
  agentWithNoIntegrations?: boolean
  deepResearchEnabled?: boolean
}

export interface ConverseResponse {
  text?: string
  metadata?: any
  cost?: number
  reasoning?: boolean
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  sources?: WebSearchSource[]
  groundingSupports?: GroundingSupport[]
}

export interface WebSearchSource {
  uri: string
  title: string
  searchQuery?: string
}

export interface GroundingSupport {
  segment: {
    startIndex: number
    endIndex: number
    text: string
  }
  groundingChunkIndices: number[]
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
export const MailParticipantSchema = z.object({
  from: z.array(z.string()).optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
})

export type MailParticipant = z.infer<typeof MailParticipantSchema>

// Zod schemas for filters
export const FiltersSchema = z.object({
  apps: z.array(z.nativeEnum(Apps)).nullable(),
  entities: z.array(entitySchema).nullable(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  sortDirection: z.string().optional(),
  count: z.preprocess((val) => (val == null ? 5 : val), z.number()),
  offset: z.preprocess((val) => (val == null ? 0 : val), z.number()),
  mailParticipants: MailParticipantSchema.optional(),
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
    chainIndex: number
    messageIndex: number
    originalQuery: string
    classification: QueryRouterLLMResponse
  }>
  usage: string
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
  wholeSheet?: boolean
  threadId?: string
  app?: Apps
  entity?: string
  url?: string
  parentThreadId?: string
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
