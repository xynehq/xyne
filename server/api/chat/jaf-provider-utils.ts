import { ModelToProviderMap } from "@/ai/mappers"
import { AIProviders, type Models } from "@/ai/types"
import type {
  ContentBlock,
  Message as ProviderMessage,
  ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime"
import type { DocumentType } from "@smithy/types"
import type { Message as JAFMessage } from "@xynehq/jaf"

export function resolveProviderType(
  provider: unknown,
  modelId?: string | null,
): AIProviders {
  const providerWithType = provider as { providerType?: string }
  const providerTypeValue = providerWithType?.providerType
  if (providerTypeValue && isKnownProvider(providerTypeValue)) {
    return providerTypeValue
  }

  if (modelId) {
    const mapped = (ModelToProviderMap as Record<string, AIProviders>)[
      modelId as Models
    ]
    if (mapped) {
      return mapped
    }
  }

  return AIProviders.OpenAI
}

const bedrockProviders = new Set<AIProviders>([AIProviders.AwsBedrock])

export function jafToProviderMessages(
  jafMessages: ReadonlyArray<JAFMessage>,
  providerType: AIProviders,
): ProviderMessage[] {
  if (providerType === AIProviders.VertexAI) {
    return convertMessagesForVertex(jafMessages)
  }

  if (bedrockProviders.has(providerType)) {
    return convertMessagesForBedrock(jafMessages)
  }

  return convertMessagesForGenericProviders(jafMessages)
}

export function zodSchemaToJsonSchema(zodSchema: any): any {
  const def = zodSchema?._def
  const typeName = def?.typeName

  const attachDesc = (schema: any, node: any) => {
    const d = node?._def?.description
    if (d) schema.description = d
    return schema
  }

  const unwrap = (inner: any) => attachDesc(zodSchemaToJsonSchema(inner), zodSchema)

  if (!def || !typeName) {
    return { type: "string" }
  }

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return unwrap(def.innerType)
  }
  if (typeName === "ZodNullable") {
    const inner = zodSchemaToJsonSchema(def.innerType)
    return attachDesc({ anyOf: [inner, { type: "null" }] }, zodSchema)
  }
  if (typeName === "ZodEffects") {
    return unwrap(def.schema || def.innerType || def.type)
  }
  if (typeName === "ZodBranded" || typeName === "ZodReadonly") {
    return unwrap(def.type || def.innerType)
  }

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
    const valSchema = zodSchemaToJsonSchema(def.valueType)
    return attachDesc(
      { type: "object", additionalProperties: valSchema },
      zodSchema,
    )
  }
  if (typeName === "ZodArray") {
    const itemSchema = zodSchemaToJsonSchema(def.type)
    return attachDesc({ type: "array", items: itemSchema }, zodSchema)
  }
  if (typeName === "ZodTuple") {
    const items = (def.items || []).map((i: any) => zodSchemaToJsonSchema(i))
    const schema: any = {
      type: "array",
      items,
      minItems: items.length,
      maxItems: items.length,
    }
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
    const options = Array.from(def.options.values()).map((o: any) =>
      zodSchemaToJsonSchema(o),
    )
    return attachDesc({ anyOf: options }, zodSchema)
  }
  if (typeName === "ZodIntersection") {
    const left = zodSchemaToJsonSchema(def.left)
    const right = zodSchemaToJsonSchema(def.right)
    return attachDesc({ allOf: [left, right] }, zodSchema)
  }

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
    const vals = Object.values(def.values).filter(
      (v) => typeof v === "string" || typeof v === "number",
    )
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
    return attachDesc(
      {
        type: "array",
        items: zodSchemaToJsonSchema(def.valueType),
        uniqueItems: true,
      },
      zodSchema,
    )
  }
  if (typeName === "ZodMap") {
    return attachDesc(
      {
        type: "object",
        additionalProperties: zodSchemaToJsonSchema(def.valueType),
      },
      zodSchema,
    )
  }
  if (typeName === "ZodAny" || typeName === "ZodUnknown") {
    return attachDesc({ type: "string" }, zodSchema)
  }

  return attachDesc({ type: "string" }, zodSchema)
}

function convertMessagesForGenericProviders(
  jafMessages: ReadonlyArray<JAFMessage>,
): ProviderMessage[] {
  const out: ProviderMessage[] = []
  for (const message of jafMessages) {
    const role = message.role === "tool" ? "assistant" : message.role
    if (role !== "user" && role !== "assistant") {
      continue
    }

    const textContent =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)

    out.push({
      role,
      content: [createTextBlock(textContent || "")],
    } as ProviderMessage)
  }
  return out
}

function convertMessagesForBedrock(
  jafMessages: ReadonlyArray<JAFMessage>,
): ProviderMessage[] {
  const out: ProviderMessage[] = []

  for (const message of jafMessages) {
    switch (message.role) {
      case "user": {
        const contentBlocks = normalizeTextContent(message.content)
        out.push({
          role: "user",
          content: contentBlocks,
        } as ProviderMessage)
        break
      }
      case "assistant": {
        const contentBlocks = normalizeTextContent(message.content)
        const toolUseBlocks: ContentBlock[] = (message.tool_calls ?? []).map((toolCall) => {
          let parsedArgs: any = {}
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments ?? "{}")
          } catch {
            parsedArgs = toolCall.function.arguments ?? {}
          }
          return {
            toolUse: {
              toolUseId: toolCall.id,
              name: toolCall.function.name,
              input: parsedArgs,
            },
          } as ContentBlock
        })

        out.push({
          role: "assistant",
          content: [...contentBlocks, ...toolUseBlocks],
        } as ProviderMessage)
        break
      }
      case "tool": {
        const toolCallId = (message as any).tool_call_id
        const rawContent =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content)
        let parsedContent: any = rawContent
        try {
          parsedContent = JSON.parse(rawContent)
        } catch {
          parsedContent = rawContent
        }

        const toolResultContent = buildToolResultContent(parsedContent)
        if (!toolCallId) {
          const fallbackBlocks = toolResultContent.map((block) => {
            if ("text" in block && block.text) {
              return createTextBlock(block.text)
            }
            return createTextBlock(JSON.stringify(block))
          })
          out.push({
            role: "user",
            content: fallbackBlocks,
          } as ProviderMessage)
          break
        }

        const status = inferToolResultStatus(parsedContent)
        out.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: toolCallId,
                content: toolResultContent,
                ...(status ? { status } : {}),
              },
            },
          ],
        } as ProviderMessage)
        break
      }
    }
  }

  return out
}

function normalizeTextContent(content: JAFMessage["content"]): ContentBlock[] {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && part.text) {
          return createTextBlock(part.text)
        }
        if (part && typeof part === "object") {
          return createTextBlock(JSON.stringify(part))
        }
        return undefined
      })
      .filter((part): part is ContentBlock => part !== undefined)
  }

  if (typeof content === "string" && content.length > 0) {
    return [createTextBlock(content)]
  }

  return []
}

function buildToolResultContent(parsed: unknown): ToolResultContentBlock[] {
  if (parsed && typeof parsed === "object") {
    const blocks: ToolResultContentBlock[] = [createToolResultJsonBlock(parsed)]

    const maybeResult = (parsed as any).result
    if (typeof maybeResult === "string" && maybeResult.trim().length > 0) {
      blocks.push(createToolResultTextBlock(maybeResult))
    }

    const maybeMessage = (parsed as any).message
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      blocks.push(createToolResultTextBlock(maybeMessage))
    }

    return blocks
  }

  const textValue = typeof parsed === "string" ? parsed : JSON.stringify(parsed)
  return [createToolResultTextBlock(textValue)]
}

function inferToolResultStatus(parsed: unknown): "success" | "error" | undefined {
  if (parsed && typeof parsed === "object" && "status" in parsed) {
    const status = String((parsed as any).status).toLowerCase()
    if (status.includes("error") || status.includes("denied")) {
      return "error"
    }
    return "success"
  }
  return undefined
}

const createTextBlock = (text: string): ContentBlock => ({ text })

const createToolResultTextBlock = (text: string): ToolResultContentBlock => ({
  text,
})

const createToolResultJsonBlock = (json: unknown): ToolResultContentBlock => ({
  json: toDocumentType(json),
})

function toDocumentType(value: unknown): DocumentType {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => toDocumentType(item))
  }

  if (typeof value === "object" && value !== undefined) {
    const normalized: Record<string, DocumentType> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = toDocumentType(val)
    }
    return normalized
  }

  return String(value ?? "")
}

function isZodSchemaRequired(zodSchema: any): boolean {
  const def = zodSchema?._def
  const typeName = def?.typeName

  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodNullable" ||
    typeName === "ZodNull"
  ) {
    return false
  }

  if (typeName === "ZodEffects" || typeName === "ZodBranded") {
    const innerType = def.schema || def.type
    if (innerType) {
      return isZodSchemaRequired(innerType)
    }
  }

  if (def?.innerType) {
    return isZodSchemaRequired(def.innerType)
  }

  if (def?.type) {
    return isZodSchemaRequired(def.type)
  }

  return true
}

function isKnownProvider(value: string): value is AIProviders {
  return (Object.values(AIProviders) as string[]).includes(value)
}

function convertMessagesForVertex(
  jafMessages: ReadonlyArray<JAFMessage>,
): ProviderMessage[] {
  const out: ProviderMessage[] = []
  for (const message of jafMessages) {
    switch (message.role) {
      case "user": {
        out.push({
          role: "user",
          content: toVertexTextBlocks(message.content),
        } as unknown as ProviderMessage)
        break
      }
      case "assistant": {
        const textBlocks = toVertexTextBlocks(message.content)
        const toolUseBlocks = (message.tool_calls ?? []).map((toolCall) => ({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: safeParseJson(toolCall.function.arguments ?? "{}"),
        }))
        const combinedContent = [...textBlocks, ...toolUseBlocks].filter(
          (block) => block !== null,
        )
        if (combinedContent.length > 0) {
          out.push({
            role: "assistant",
            content: combinedContent,
          } as unknown as ProviderMessage)
        }
        break
      }
      case "tool": {
        const toolCallId = (message as any).tool_call_id
        const summary = summariseToolResultContent(message.content)
        if (toolCallId) {
          const textBlock = createVertexTextBlock(summary)
          if (!textBlock) break
          out.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: [textBlock],
                is_error: false,
              },
            ],
          } as unknown as ProviderMessage)
        } else {
          const textBlock = createVertexTextBlock(summary)
          if (textBlock) {
            out.push({
              role: "user",
              content: [textBlock],
            } as unknown as ProviderMessage)
          }
        }
        break
      }
      default:
        break
    }
  }
  return out
}

function createVertexTextBlock(text: string) {
  const trimmed = typeof text === "string" ? text.trim() : ""
  if (!trimmed) return null
  return {
    type: "text",
    text: trimmed,
  }
}

function toVertexTextBlocks(content: JAFMessage["content"]): any[] {
  const blocks: any[] = []
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue
      if (typeof part === "object" && "type" in part) {
        blocks.push(part)
      } else if (typeof part === "object" && "text" in part) {
        const block = createVertexTextBlock(part.text ?? "")
        if (block) blocks.push(block)
      } else {
        const block = createVertexTextBlock(summariseUnknown(part))
        if (block) blocks.push(block)
      }
    }
  } else if (typeof content === "string") {
    const block = createVertexTextBlock(content)
    if (block) blocks.push(block)
  } else if (content !== undefined && content !== null) {
    const block = createVertexTextBlock(summariseUnknown(content))
    if (block) blocks.push(block)
  }

  return blocks
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function summariseToolResultContent(content: JAFMessage["content"]): string {
  const rawText = extractRawText(content)
  if (!rawText) return ""
  try {
    const parsed = JSON.parse(rawText)
    if (parsed && typeof parsed === "object") {
      const status = typeof (parsed as any).status === "string"
        ? (parsed as any).status
        : "executed"
      const result = (parsed as any).result
      const message = (parsed as any).message
      return [
        `status: ${status}`,
        result ? `result: ${formatMaybeObject(result)}` : null,
        message ? `message: ${formatMaybeObject(message)}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    }
  } catch {}
  return rawText.trim()
}

function extractRawText(content: JAFMessage["content"]): string {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return part.text
        }
        return summariseUnknown(part)
      })
      .filter((text) => text && text.length > 0)
      .join("\n")
  }
  if (content !== undefined && content !== null) {
    return summariseUnknown(content)
  }
  return ""
}

function summariseUnknown(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatMaybeObject(value: unknown): string {
  if (typeof value === "string") return value
  return summariseUnknown(value)
}
