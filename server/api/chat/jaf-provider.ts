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
      const tools = (agent.tools || []).map((t) => {
        const params: any = t.schema.parameters as any
        const raw = params && params.__xyne_raw_json_schema
        return {
          name: t.schema.name,
          description: t.schema.description,
          // Prefer exact JSON Schema if present (e.g., MCP tools), else convert from Zod
          parameters: raw && typeof raw === 'object' ? raw : zodSchemaToJsonSchema(t.schema.parameters),
        }
      })

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

// Minimal yet robust Zod -> JSON Schema converter for tool parameters
function zodSchemaToJsonSchema(zodSchema: any): any {
  const def = zodSchema?._def
  const typeName = def?.typeName

  // Attach description from the provided Zod node (not just current scope)
  const attachDesc = (schema: any, node: any) => {
    const d = node?._def?.description
    if (d) schema.description = d
    return schema
  }

  // Common unwrappers for wrapper types where we just want the inner shape
  const unwrap = (inner: any) => attachDesc(zodSchemaToJsonSchema(inner), zodSchema)

  if (!def || !typeName) {
    // Unknown node; return a permissive but valid schema
    return { type: "string" }
  }

  // Handle common wrappers first to preserve optional/nullable semantics
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return unwrap(def.innerType)
  }
  if (typeName === "ZodNullable") {
    const inner = zodSchemaToJsonSchema(def.innerType)
    return attachDesc({ anyOf: [inner, { type: "null" }] }, zodSchema)
  }
  if (typeName === "ZodEffects") {
    // Effects add parsing/transform logic; for schema purposes, unwrap
    return unwrap(def.schema || def.innerType || def.type)
  }
  if (typeName === "ZodBranded" || typeName === "ZodReadonly") {
    return unwrap(def.type || def.innerType)
  }

  // Core compound/object types
  if (typeName === "ZodObject") {
    const shape = def.shape()
    const properties: Record<string, any> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodSchemaToJsonSchema(value)
      if (isZodSchemaRequired(value)) required.push(key)
    }
    const obj: any = {
      type: "object",
      properties,
      additionalProperties: false,
    }
    if (required.length) obj.required = required
    return attachDesc(obj, zodSchema)
  }
  if (typeName === "ZodRecord") {
    // Represent records as object with additionalProperties
    const valSchema = zodSchemaToJsonSchema(def.valueType)
    return attachDesc({ type: "object", additionalProperties: valSchema }, zodSchema)
  }
  if (typeName === "ZodArray") {
    const itemSchema = zodSchemaToJsonSchema(def.type)
    return attachDesc({ type: "array", items: itemSchema }, zodSchema)
  }
  if (typeName === "ZodTuple") {
    const items = (def.items || []).map((i: any) => zodSchemaToJsonSchema(i))
    const schema: any = { type: "array", items, minItems: items.length, maxItems: items.length }
    if (def.rest) {
      schema.additionalItems = zodSchemaToJsonSchema(def.rest)
      delete schema.maxItems
    } else {
      schema.additionalItems = false
    }
    return attachDesc(schema, zodSchema)
  }
  if (typeName === "ZodUnion") {
    const options = (def.options || []).map((o: any) => zodSchemaToJsonSchema(o))
    return attachDesc({ anyOf: options }, zodSchema)
  }
  if (typeName === "ZodDiscriminatedUnion") {
    const options = Array.from(def.options.values()).map((o: any) => zodSchemaToJsonSchema(o))
    return attachDesc({ anyOf: options }, zodSchema)
  }
  if (typeName === "ZodIntersection") {
    const left = zodSchemaToJsonSchema(def.left)
    const right = zodSchemaToJsonSchema(def.right)
    return attachDesc({ allOf: [left, right] }, zodSchema)
  }

  // Core scalar types
  if (typeName === "ZodString") {
    return attachDesc({ type: "string" }, zodSchema)
  }
  if (typeName === "ZodNumber") {
    const checks = def?.checks
    if (Array.isArray(checks) && checks.some((c: any) => c?.kind === "int")) {
      return attachDesc({ type: "integer" }, zodSchema)
    }
    return attachDesc({ type: "number" }, zodSchema)
  }
  if (typeName === "ZodBigInt") {
    return attachDesc({ type: "integer" }, zodSchema)
  }
  if (typeName === "ZodBoolean") {
    return attachDesc({ type: "boolean" }, zodSchema)
  }
  if (typeName === "ZodDate") {
    return attachDesc({ type: "string", format: "date-time" }, zodSchema)
  }
  if (typeName === "ZodNull") {
    return attachDesc({ type: "null" }, zodSchema)
  }
  if (typeName === "ZodEnum") {
    return attachDesc({ type: "string", enum: def.values }, zodSchema)
  }
  if (typeName === "ZodNativeEnum") {
    const vals = Object.values(def.values).filter((v) => typeof v === "string" || typeof v === "number")
    return attachDesc({ enum: vals }, zodSchema)
  }
  if (typeName === "ZodLiteral") {
    const v = def.value
    const litSchema: any = { enum: [v] }
    if (typeof v === "string") litSchema.type = "string"
    else if (typeof v === "number") litSchema.type = "number"
    else if (typeof v === "boolean") litSchema.type = "boolean"
    return attachDesc(litSchema, zodSchema)
  }
  if (typeName === "ZodSet") {
    return attachDesc({ type: "array", items: zodSchemaToJsonSchema(def.valueType), uniqueItems: true }, zodSchema)
  }
  if (typeName === "ZodMap") {
    // Approximate maps as object with free-form values
    return attachDesc({ type: "object", additionalProperties: zodSchemaToJsonSchema(def.valueType) }, zodSchema)
  }
  if (typeName === "ZodAny" || typeName === "ZodUnknown") {
    // Permissive schema without noisy placeholder descriptions
    return attachDesc({ type: "string" }, zodSchema)
  }

  // Last resort: fall back to a simple string without adding placeholder description
  return attachDesc({ type: "string" }, zodSchema)
}
