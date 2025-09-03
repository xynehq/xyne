import { z } from "zod"
import config from "@/config"
import { getProviderByModel } from "@/ai/provider"
import type { Message as ProviderMessage } from "@aws-sdk/client-bedrock-runtime"
import type {
  ModelProvider as JAFModelProvider,
  RunState,
  Agent as JAFAgent,
  RunConfig as JAFRunConfig,
  Message as JAFMessage,
} from "@xynehq/jaf"
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

export const makeXyneJAFProvider = <Ctx>(
  opts: MakeXyneJAFProviderOptions = {},
): JAFModelProvider<Ctx> => {
  return {
    async getCompletion(state, agent, runCfg) {
      const model = runCfg.modelOverride ?? agent.modelConfig?.name
      if (!model) {
        throw new Error(`Model not specified for agent ${agent.name}`)
      }
      // Use Xyne’s native provider stack for the selected model.
      const provider = getProviderByModel(model as any)

      // Convert JAF message history to provider format (Bedrock-style Message[])
      const providerMessages: ProviderMessage[] = jafToProviderMessages(
        state.messages,
      )

      // Map JAF tools (if any) into provider tool specs via JSON Schema
      const tools = (agent.tools || []).map((t) => ({
        name: t.schema.name,
        description: t.schema.description,
        parameters: zodSchemaToJsonSchema(t.schema.parameters),
      }))

      // Allow per-agent/per-run toggles from context.advancedConfig.run
      const advRun = (state.context as any)?.advancedConfig?.run || {}

      const result = await provider.converse(providerMessages, {
        modelId: model as any,
        stream: false,
        json: !!agent.outputCodec,
        temperature: agent.modelConfig?.temperature,
        max_new_tokens: agent.modelConfig?.maxTokens,
        systemPrompt: agent.instructions(state),
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? advRun.toolChoice ?? 'auto' : undefined,
        parallel_tool_calls: tools.length ? advRun.parallelToolCalls ?? true : undefined,
      } as any)

      const content = result.text || ""
      // Return JAF-compatible shape with message content and tool calls, if any
      return {
        message: {
          content,
          ...(result.tool_calls && result.tool_calls.length
            ? { tool_calls: result.tool_calls }
            : {}),
        },
      }
    },
  }
}

// Map JAF message history into provider Message[] (AWS Bedrock-style)
function jafToProviderMessages(
  jafMessages: ReadonlyArray<JAFMessage>,
): ProviderMessage[] {
  const out: ProviderMessage[] = []
  for (const m of jafMessages) {
    if (m.role === "user" || m.role === "assistant") {
      out.push({
        role: m.role,
        content: [
          {
            text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        ],
      } as ProviderMessage)
    } else if (m.role === "tool") {
      // Providers outside OpenAI don’t support tool messages; embed as assistant text for context
      const text =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      out.push({
        role: "assistant",
        content: [
          {
            text,
          },
        ],
      } as ProviderMessage)
    }
  }
  return out
}

// No OpenAI message conversion needed when using native provider hub only.

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
