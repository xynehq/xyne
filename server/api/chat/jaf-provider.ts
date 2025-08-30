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

type OpenAIChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

export const makeXyneJAFProvider = <Ctx>(
  opts: MakeXyneJAFProviderOptions = {},
): JAFModelProvider<Ctx> => {
  const baseURL = opts.baseURL ?? config.aiProviderBaseUrl
  // OpenAI API key may be optional if using a proxy that ignores auth
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

      const lastMessage = state.messages[state.messages.length - 1]
      const isAfterToolCall = lastMessage?.role === "tool"

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

      // Augment with usage so engine can emit token_usage events
      return {
        ...choice,
        usage: resp.usage,
      } as any
    },
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
