import config from "@/config"
import { messageFeedbackEnum } from "@/db/schema"
import { Apps, type Entity } from "@xyne/vespa-ts/types"
import type { Span } from "@/tracer"
import { z } from "zod"
import { entitySchema } from "@/shared/types"
import type { ConverseResponse } from "@/ai/types"

const {
  JwtPayloadKey,
  chatHistoryPageSize,
  defaultBestModel,
  defaultFastModel,
  maxDefaultSummary,
  chatPageSize,
  isReasoning,
  fastModelReasoning,
  StartThinkingToken,
  EndThinkingToken,
  maxValidLinks,
} = config
// this is not always the case but unless our router detects that we need
// these we will by default remove them
const nonWorkMailLabels = ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"]

export enum RagPipelineStages {
  QueryRouter = "QueryRouter",
  NewChatTitle = "NewChatTitle",
  AnswerOrSearch = "AnswerOrSearch",
  AnswerWithList = "AnswerWithList",
  AnswerOrRewrite = "AnswerOrRewrite",
  RewriteAndAnswer = "RewriteAndAnswer",
  UserChat = "UserChat",
  DefaultRetrieval = "DefaultRetrieval",
}

export const ragPipelineConfig = {
  [RagPipelineStages.QueryRouter]: {
    modelId: defaultFastModel,
    reasoning: fastModelReasoning,
  },
  [RagPipelineStages.AnswerOrSearch]: {
    modelId: defaultBestModel, //defaultBestModel,
    reasoning: fastModelReasoning,
  },
  [RagPipelineStages.AnswerWithList]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.NewChatTitle]: {
    modelId: defaultFastModel,
  },
  [RagPipelineStages.AnswerOrRewrite]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.RewriteAndAnswer]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.UserChat]: {
    modelId: defaultBestModel,
  },
  [RagPipelineStages.DefaultRetrieval]: {
    modelId: defaultBestModel,
    page: 5,
  },
}

export const MinimalCitationSchema = z.object({
  docId: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  app: z.nativeEnum(Apps),
  entity: entitySchema,
  threadId: z.string().optional(),
  page_title: z.string().optional(),
  itemId: z.string().optional(),
  clId: z.string().optional(),
  parentThreadId: z.string().optional(),
})

export type Citation = z.infer<typeof MinimalCitationSchema>

export interface ImageCitation {
  citationKey: string
  imagePath: string
  imageData: string
  item: Citation
  mimeType?: string
}

export type ConverseResponseWithCitations = ConverseResponse & {
  citation?: { index: number; item: any }
  imageCitation?: ImageCitation
}

export interface MinimalAgentFragment {
  id: string // Unique ID for the fragment
  content: string
  source: Citation
  confidence: number
  imageFileNames?: string[]
}

export const messageFeedbackSchema = z.object({
  messageId: z.string(),
  feedback: z.enum(messageFeedbackEnum.enumValues).nullable(), // Allows 'like', 'dislike', or null
})

// Enhanced feedback schema for new feedback system
export const enhancedMessageFeedbackSchema = z.object({
  messageId: z.string(),
  type: z.enum(["like", "dislike"]),
  customFeedback: z.string().optional(),
  selectedOptions: z.array(z.string()).optional(),
  shareChat: z.boolean().optional(), // New field for share chat option
})

export interface AgentTool {
  name: string
  description: string
  parameters: Record<
    string,
    {
      type: string
      description: string
      required: boolean
    }
  >
  execute: (
    params: any,
    span?: Span,
    email?: string,
    userCtx?: string,
    agentPrompt?: string,
    userMessage?: string,
  ) => Promise<{
    result: string // Human-readable summary of action/result
    contexts?: MinimalAgentFragment[] // Data fragments found
    error?: string // Error message if failed
    fallbackReasoning?: string // Detailed reasoning about why search failed
  }>
}
export interface MetadataRetrievalParams {
  from?: string
  to?: string
  app: string
  entity?: string
  filter_query?: string
  limit?: number
  offset?: number
  order_direction?: "asc" | "desc"
  excludedIds?: string[]
  intent?: {
    from?: string[]
    to?: string[]
    cc?: string[]
    bcc?: string[]
  }
}

export interface SearchParams {
  query: string
  limit?: number
  sortBy?: "asc" | "desc"
  offset?: number
  excludedIds?: string[]
  timeRange?: {
    startTime?: string
    endTime?: string
  }
}

export interface ConversationalParams {
  // No parameters
}

export interface SlackThreadsParams {
  filter_query?: string
  limit?: number
  offset?: number
  order_direction?: string
}

export interface SlackRelatedMessagesParams {
  channel_name: string
  filter_query?: string
  user_email?: string
  limit?: number
  offset?: number
  order_direction?: string
  from?: string
  to?: string
}

export interface SlackUserProfileParams {
  user_email: string
}
