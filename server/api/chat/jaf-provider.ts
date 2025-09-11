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
import { getTextContent } from "@xynehq/jaf"

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
            text: getTextContent(m.content),
          },
        ],
      } as ProviderMessage)
    } else if (m.role === "tool") {
      // Providers outside OpenAI don’t support tool messages; embed as assistant text for context
      const text = getTextContent(m.content)
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

// Helper to recursively unwrap Zod wrapper types and determine if field is required
function isZodSchemaRequired(zodSchema: any): boolean {
  const def = zodSchema?._def
  const typeName = def?.typeName

  // These wrapper types make a field optional/not required
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodNullable" ||
    typeName === "ZodNull"
  ) {
    return false
  }

  // These wrapper types need to be unwrapped to check the inner type
  if (typeName === "ZodEffects" || typeName === "ZodBranded") {
    const innerType = def.schema || def.type
    if (innerType) {
      return isZodSchemaRequired(innerType)
    }
  }

  // For other wrapper types that have innerType
  if (def?.innerType) {
    return isZodSchemaRequired(def.innerType)
  }

  // For other wrapper types that have type
  if (def?.type) {
    return isZodSchemaRequired(def.type)
  }

  // Base case: if we reach here, it's a core type that is required by default
  return true
}

// Minimal Zod -> JSON Schema converter sufficient for tool parameters
function zodSchemaToJsonSchema(zodSchema: any): any {
  const def = zodSchema?._def
  const typeName = def?.typeName

  // Helper to attach description from any Zod node (including wrappers)
  const withDesc = (schema: any) => {
    if (def?.description) {
      schema.description = def.description
    }
    return schema
  }

  if (typeName === "ZodOptional") {
    // Preserve description on the optional wrapper
    const inner = zodSchemaToJsonSchema(def.innerType)
    return withDesc(inner)
  }

  if (typeName === "ZodObject") {
    const shape = def.shape()
    const properties: Record<string, any> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodSchemaToJsonSchema(value)
      if (isZodSchemaRequired(value)) {
        required.push(key)
      }
    }
    return withDesc({
      type: "object",
      properties,
      required: required.length ? required : undefined,
      additionalProperties: false,
    })
  }

  if (typeName === "ZodString") {
    return withDesc({ type: "string" })
  }
  if (typeName === "ZodNumber") {
    return withDesc({ type: "number" })
  }
  if (typeName === "ZodBoolean") {
    return withDesc({ type: "boolean" })
  }
  if (typeName === "ZodArray") {
    return withDesc({ type: "array", items: zodSchemaToJsonSchema(def.type) })
  }
  if (typeName === "ZodEnum") {
    return withDesc({ type: "string", enum: def.values })
  }

  // Fallback
  return withDesc({ type: "string", description: "Unsupported schema type" })
}
