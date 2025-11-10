/* eslint-disable @typescript-eslint/naming-convention */
import { z } from 'zod'

/**
 * Zod schemas for LiteLLM provider
 * Comprehensive validation for all LiteLLM-specific types
 * 
 * Note: snake_case properties follow OpenAI API conventions
 * ESLint naming-convention warnings are disabled for API compatibility
 */

/**
 * LiteLLM provider configuration schema
 */
export const LiteLLMConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z.string().url().optional(),
  timeout: z.number().positive().default(30000),
  retries: z.number().int().min(0).max(5).default(3),
  rateLimiting: z.boolean().default(true),
  enableLogging: z.boolean().default(true),
  //@ts-ignore
  customHeaders: z.record(z.string()).optional(),
  proxyUrl: z.string().url().optional()
})

export type LiteLLMConfig = z.infer<typeof LiteLLMConfigSchema>

/**
 * LiteLLM message schema (follows OpenAI format)
 */
export const LiteLLMMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.union([
    z.string(),
    z.array(z.object({
      type: z.enum(['text', 'image_url', 'file', 'tool_use', 'tool_result']),
      text: z.string().optional(),
      image_url: z.object({
        url: z.string(),
        detail: z.enum(['auto', 'low', 'high']).optional()
      }).optional(),
      file: z.object({
        file_id: z.string().optional(),
        file_data: z.string().optional(),
        format: z.string().optional()
      }).optional(),
      tool_use_id: z.string().optional(),
      content: z.unknown().optional()
    }))
  ]),
  name: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string()
    })
  })).optional(),
  tool_call_id: z.string().optional()
})

export type LiteLLMMessage = z.infer<typeof LiteLLMMessageSchema>

/**
 * LiteLLM chat completion request schema
 */
export const LiteLLMRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(LiteLLMMessageSchema),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string(),
      //@ts-ignore
      parameters: z.record(z.unknown())
    })
  })).optional(),
  tool_choice: z.union([
    z.literal('auto'),
    z.literal('none'),
    z.object({
      type: z.literal('function'),
      function: z.object({
        name: z.string()
      })
    })
  ]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  user: z.string().optional(),
  thinking: z.union([
    z.boolean().optional(),
    z.object({
      type: z.literal("enabled"),
      budget_tokens: z.number().int().positive()
    }).optional()
  ]).optional(),
  response_format: z.object({
    type: z.literal("json_object")
  }).optional()
})

export type LiteLLMRequest = z.infer<typeof LiteLLMRequestSchema>

/**
 * LiteLLM usage information schema
 */
export const LiteLLMUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  thinking_tokens: z.number().int().nonnegative().optional()
})

export type LiteLLMUsage = z.infer<typeof LiteLLMUsageSchema>

/**
 * LiteLLM choice schema
 */
export const LiteLLMChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.literal('function'),
      function: z.object({
        name: z.string(),
        arguments: z.string()
      })
    })).optional(),
    thinking: z.string().optional(), // For Claude 4 thinking mode
    thinkingSignature: z.string().optional(), // Claude 4 thinking signature
    reasoning_content: z.string().optional(), // LiteLLM thinking content
    thinking_blocks: z.array(z.object({
      type: z.string().optional(),
      thinking: z.string().optional(),
      signature: z.string().optional()
    })).optional() // LiteLLM thinking blocks
  }),
  finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']).nullable(),
  logprobs: z.unknown().nullable().optional()
})

export type LiteLLMChoice = z.infer<typeof LiteLLMChoiceSchema>

/**
 * LiteLLM chat completion response schema
 */
export const LiteLLMResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int().positive(),
  model: z.string(),
  choices: z.array(LiteLLMChoiceSchema),
  usage: LiteLLMUsageSchema.optional(),
  system_fingerprint: z.string().optional()
})

export type LiteLLMResponse = z.infer<typeof LiteLLMResponseSchema>

/**
 * LiteLLM streaming chunk schema
 */
export const LiteLLMStreamChunkSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number().int().positive(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.number().int().nonnegative(),
    delta: z.object({
      role: z.enum(['assistant']).optional(),
      content: z.string().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative().optional(),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional()
        }).optional()
      })).optional(),
      thinking: z.string().optional(), // Claude 4 thinking content
      thinkingSignature: z.string().optional() // Claude 4 thinking signature
    }),
    finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable().optional(),
    logprobs: z.unknown().nullable().optional()
  })),
  usage: LiteLLMUsageSchema.optional()
})

export type LiteLLMStreamChunk = z.infer<typeof LiteLLMStreamChunkSchema>

/**
 * LiteLLM error response schema
 */
export const LiteLLMErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    param: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional()
  })
})

export type LiteLLMError = z.infer<typeof LiteLLMErrorSchema>

/**
 * Model information schema for LiteLLM
 */
export const LiteLLMModelInfoSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number().int().positive().optional(),
  owned_by: z.string().optional(),
  permission: z.array(z.unknown()).optional(),
  root: z.string().optional(),
  parent: z.string().optional()
})

export type LiteLLMModelInfo = z.infer<typeof LiteLLMModelInfoSchema>

/**
 * Validation helper functions
 */
export function validateLiteLLMConfig(config: unknown): config is LiteLLMConfig {
  try {
    LiteLLMConfigSchema.parse(config)
    return true
  } catch {
    return false
  }
}

export function validateLiteLLMRequest(request: unknown): request is LiteLLMRequest {
  try {
    LiteLLMRequestSchema.parse(request)
    return true
  } catch {
    return false
  }
}

/**
 * Schema parsing with error handling
 */
export function parseLiteLLMResponse(data: unknown): LiteLLMResponse {
  return LiteLLMResponseSchema.parse(data)
}

export function parseLiteLLMStreamChunk(data: unknown): LiteLLMStreamChunk {
  return LiteLLMStreamChunkSchema.parse(data)
}

export function parseLiteLLMError(data: unknown): LiteLLMError {
  return LiteLLMErrorSchema.parse(data)
}

export function parseLiteLLMModelInfo(data: unknown): LiteLLMModelInfo {
  return LiteLLMModelInfoSchema.parse(data)
}
