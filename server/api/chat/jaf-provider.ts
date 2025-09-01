import OpenAI from "openai"
import { z } from "zod"
import config from "@/config"
import type {
  ModelProvider as JAFModelProvider,
  RunState,
  Agent as JAFAgent,
  RunConfig as JAFRunConfig,
  Message as JAFMessage,
} from "@xynehq/jaf"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"

type OpenAIChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam
type AnthropicMessage = { role: "user" | "assistant"; content: string }

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

export const makeXyneJAFProvider = <Ctx>(
  opts: MakeXyneJAFProviderOptions = {},
): JAFModelProvider<Ctx> => {
  // Check for Vertex AI environment variables
  const vertexProjectId = process.env.VERTEX_PROJECT_ID
  const vertexRegion = process.env.VERTEX_REGION
  const vertexModel = process.env.VERTEX_AI_MODEL

  const isVertexAI = !!(vertexProjectId && vertexRegion && vertexModel)

  if (isVertexAI) {
    // Use Anthropic Vertex SDK for Vertex AI
    const vertexClient = new AnthropicVertex({
      projectId: vertexProjectId,
      region: vertexRegion,
    })

    return {
      async getCompletion(state, agent, _runCfg) {
        // Always use Vertex AI Claude model when Vertex AI is configured
        const model = vertexModel
        if (!model) {
          throw new Error(`Vertex AI model not specified: ${vertexModel}`)
        }

        const systemPrompt = agent.instructions(state)
        const messages = state.messages.map(convertToAnthropicMessage)

        const tools = (agent.tools || []).map((t) => ({
          name: t.schema.name,
          description: t.schema.description,
          input_schema: zodSchemaToJsonSchema(t.schema.parameters),
        }))

        const requestParams: any = {
          model,
          max_tokens: agent.modelConfig?.maxTokens || 4096,
          temperature: agent.modelConfig?.temperature || 0.7,
          system: systemPrompt,
          messages,
          tools: tools.length ? tools : undefined,
        }

        const response = await vertexClient.beta.messages.create(requestParams)

        // Convert Anthropic response to OpenAI-compatible format for JAF
        const content = response.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("")

        const toolCalls = response.content
          .filter((c: any) => c.type === "tool_use")
          .map((c: any) => ({
            id: c.id,
            type: "function" as const,
            function: {
              name: c.name,
              arguments: JSON.stringify(c.input),
            },
          }))

        const usage = response.usage || { input_tokens: 0, output_tokens: 0 }

        return {
          message: {
            content: content || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          usage: {
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
          },
        } as any
      },
    }
  } else {
    // Use OpenAI for non-Vertex AI cases
    const baseURL = opts.baseURL ?? config.aiProviderBaseUrl
    const apiKey = (opts.apiKey ?? config.OpenAIKey) || "anything"

    const client = new OpenAI({
      ...(baseURL ? { baseURL } : {}),
      apiKey,
      dangerouslyAllowBrowser: true,
    })

    return {
      async getCompletion(state, agent, runCfg) {
        const model = runCfg.modelOverride ?? agent.modelConfig?.name
        if (!model) {
          throw new Error(`Model not specified for agent ${agent.name}`)
        }

        const systemMessage: OpenAIChatMsg = {
          role: "system",
          content: agent.instructions(state),
        }

        const messages: OpenAIChatMsg[] = [systemMessage, ...state.messages.map(convertMessage)]

        const tools = (agent.tools || []).map((t) => ({
          type: "function" as const,
          function: {
            name: t.schema.name,
            description: t.schema.description,
            parameters: zodSchemaToJsonSchema(t.schema.parameters),
          },
        }))

        const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
          model,
          messages,
          temperature: agent.modelConfig?.temperature,
          max_tokens: agent.modelConfig?.maxTokens,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          parallel_tool_calls: tools.length ? true : undefined,
          response_format: agent.outputCodec ? { type: "json_object" } : undefined,
        }

        const resp = await client.chat.completions.create(requestParams)
        const choice = resp.choices[0]

        return {
          ...choice,
          usage: resp.usage,
        } as any
      },
    }
  }
}

function convertMessage(msg: JAFMessage): OpenAIChatMsg {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content }
    case "assistant":
      return {
        role: "assistant",
        content: msg.content,
        tool_calls: msg.tool_calls as any,
      }
    case "tool":
      return {
        role: "tool",
        content: msg.content,
        tool_call_id: msg.tool_call_id!,
      }
    default:
      throw new Error(`Unknown message role: ${(msg as any).role}`)
  }
}

function convertToAnthropicMessage(msg: JAFMessage): AnthropicMessage {
  switch (msg.role) {
    case "user":
      return { role: "user", content: msg.content }
    case "assistant":
      // For Anthropic, we need to handle tool calls differently
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // If there are tool calls, we need to include them in the content
        let content = msg.content || ""
        // Note: Anthropic handles tool calls in the content array, not as separate tool_calls
        // This is a simplified approach - in practice, you might need more sophisticated handling
        return { role: "assistant", content }
      }
      return { role: "assistant", content: msg.content }
    case "tool":
      // Tool responses become user messages in Anthropic format
      // Include the tool response content
      return { role: "user", content: msg.content }
    default:
      throw new Error(`Unknown message role: ${(msg as any).role}`)
  }
}

// Minimal Zod -> JSON Schema converter sufficient for tool parameters
function zodSchemaToJsonSchema(zodSchema: any): any {
  const def = zodSchema?._def
  const typeName = def?.typeName

  if (typeName === "ZodObject") {
    const shape = def.shape()
    const properties: Record<string, any> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodSchemaToJsonSchema(value)
      if (!(value as any).isOptional()) required.push(key)
    }
    return {
      type: "object",
      properties,
      required: required.length ? required : undefined,
      additionalProperties: false,
    }
  }

  if (typeName === "ZodString") {
    const schema: any = { type: "string" }
    if (def?.description) schema.description = def.description
    return schema
  }
  if (typeName === "ZodNumber") return { type: "number" }
  if (typeName === "ZodBoolean") return { type: "boolean" }
  if (typeName === "ZodArray")
    return { type: "array", items: zodSchemaToJsonSchema(def.type) }
  if (typeName === "ZodOptional") return zodSchemaToJsonSchema(def.innerType)
  if (typeName === "ZodEnum") return { type: "string", enum: def.values }

  // Fallback
  return { type: "string", description: "Unsupported schema type" }
}
