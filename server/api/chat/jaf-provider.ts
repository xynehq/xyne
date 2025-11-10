import { getAISDKProviderByModel } from "@/ai/provider"
import { MODEL_CONFIGURATIONS } from "@/ai/modelConfig"
import type {
  ModelProvider as JAFModelProvider,
  Message as JAFMessage,
  Agent as JAFAgent,
} from "@xynehq/jaf"
import { getTextContent } from "@xynehq/jaf"
import { Models, AIProviders } from "@/ai/types"
import { ModelToProviderMap } from "@/ai/mappers"
import type {
  JSONSchema7,
  JSONValue,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2Message,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolChoice,
  LanguageModelV2ToolResultOutput,
  LanguageModelV2TextPart,
  LanguageModelV2FilePart,
  LanguageModelV2ReasoningPart,
  LanguageModelV2ToolCallPart,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider"
import OpenAI from "openai"
import config from "@/config"
import { zodSchemaToJsonSchema } from "./jaf-provider-utils"

export type MakeXyneJAFProviderOptions = {
  baseURL?: string
  apiKey?: string
}

export const makeXyneJAFProvider = <Ctx>(
  _opts: MakeXyneJAFProviderOptions = {},
): JAFModelProvider<Ctx> => {
  return {
    async getCompletion(state, agent, runCfg) {
      const model = runCfg.modelOverride ?? agent.modelConfig?.name
      if (!model) {
        throw new Error(`Model not specified for agent ${agent.name}`)
      }

      const modelConfig = MODEL_CONFIGURATIONS[model as Models]
      const actualModelId = modelConfig?.actualName ?? model
      
      // Check if this is a LiteLLM model - use OpenAI client directly like JAF does
      const providerType = ModelToProviderMap[model as Models]
      
      if (providerType === AIProviders.LiteLLM) {
        // Use OpenAI client directly for LiteLLM (same as JAF's makeLiteLLMProvider)
        const { LiteLLMBaseUrl, LiteLLMApiKey } = config
        if (!LiteLLMBaseUrl) {
          throw new Error(
            "LiteLLM base URL not configured. Cannot route LiteLLM provider calls.",
          )
        }
        if (!LiteLLMApiKey) {
          throw new Error(
            "LiteLLM API key not configured. Cannot route LiteLLM provider calls.",
          )
        }

        const client = new OpenAI({
          baseURL: LiteLLMBaseUrl,
          apiKey: LiteLLMApiKey,
        })

        // Build messages in OpenAI format
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
        
        // Add system message
        messages.push({
          role: "system",
          content: agent.instructions(state),
        })

        // Convert JAF messages to OpenAI format
        for (const message of state.messages) {
          if (message.role === "user") {
            const text = getTextContent(message.content) || ""
            messages.push({
              role: "user",
              content: text,
            })
          } else if (message.role === "assistant") {
            const text = getTextContent(message.content) || ""
            const toolCalls = message.tool_calls?.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments:
                  typeof tc.function.arguments === "string"
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
              },
            }))

            messages.push({
              role: "assistant",
              content: text || null,
              ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            })
          } else if (message.role === "tool") {
            const toolCallId = (message as { tool_call_id?: string }).tool_call_id
            const content = getTextContent(message.content) || ""
            if (toolCallId) {
              messages.push({
                role: "tool",
                tool_call_id: toolCallId,
                content: content,
              })
            }
          }
        }

        // Build tools in OpenAI format
        const tools = buildFunctionTools(agent).map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as any,
          },
        }))

        const advRun = (
          state.context as {
            advancedConfig?: {
              run?: {
                parallelToolCalls: boolean
                toolChoice: "auto" | "none" | "required" | undefined
              }
            }
          }
        )?.advancedConfig?.run

        // Create completion request
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
          model: actualModelId,
          messages: messages,
          temperature: agent.modelConfig?.temperature,
          max_tokens: agent.modelConfig?.maxTokens,
          ...(tools.length > 0 ? { tools } : {}),
          ...(tools.length > 0 && advRun?.toolChoice
            ? { tool_choice: advRun.toolChoice }
            : {}),
          ...(tools.length > 0 && advRun?.parallelToolCalls !== undefined
            ? { parallel_tool_calls: advRun.parallelToolCalls }
            : {}),
        }

        if (agent.outputCodec) {
          params.response_format = { type: "json_object" }
        }

        const resp = await client.chat.completions.create(params)

        // Return in JAF format (same as JAF's makeLiteLLMProvider)
        const choice = resp.choices[0]
        const message = choice?.message
        
        const toolCalls = message?.tool_calls
          ?.filter((tc) => tc.type === "function" && "function" in tc)
          ?.map((tc) => {
            const toolCall = tc as Extract<typeof tc, { type: "function"; function: any }>
            return {
              id: toolCall.id || "",
              type: "function" as const,
              function: {
                name: toolCall.function.name || "",
                arguments:
                  typeof toolCall.function.arguments === "string"
                    ? toolCall.function.arguments
                    : JSON.stringify(toolCall.function.arguments || {}),
              },
            }
          })
        
        return {
          message: {
            content: message?.content || null,
            ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
        }
      }

      // For other providers, use AI SDK as before
      const provider = getAISDKProviderByModel(model as Models)
      const languageModel = provider.languageModel(actualModelId)

      const prompt = buildPromptFromMessages(
        state.messages,
        agent.instructions(state),
      )
      const tools = buildFunctionTools(agent)
      const advRun = (
        state.context as {
          advancedConfig?: {
            run?: {
              parallelToolCalls: boolean
              toolChoice: "auto" | "none" | "required" | undefined
            }
          }
        }
      )?.advancedConfig?.run

      const callOptions: LanguageModelV2CallOptions = {
        prompt,
        maxOutputTokens: agent.modelConfig?.maxTokens,
        temperature: agent.modelConfig?.temperature,
        ...(tools.length ? { tools } : {}),
      }

      if (tools.length) {
        callOptions.toolChoice = mapToolChoice(advRun?.toolChoice)
      }

      if (agent.outputCodec) {
        callOptions.responseFormat = {
          type: "json",
          schema: zodSchemaToJsonSchema(agent.outputCodec) as JSONSchema7,
        }
      }

      const result = await languageModel.doGenerate(callOptions)

      const message = convertResultToJAFMessage(result.content)

      return { message }
    },
  }
}

type SchemaWithRawJson = {
  __xyne_raw_json_schema?: JSONSchema7
}

const mapToolChoice = (
  choice: "auto" | "none" | "required" | undefined,
): LanguageModelV2ToolChoice | undefined => {
  if (!choice) return undefined
  switch (choice) {
    case "auto":
      return { type: "auto" }
    case "none":
      return { type: "none" }
    case "required":
      return { type: "required" }
    default:
      return undefined
  }
}

const buildFunctionTools = <Ctx, Out>(
  agent: Readonly<JAFAgent<Ctx, Out>>,
): LanguageModelV2FunctionTool[] => {
  const ensureObjectSchema = (schema: JSONSchema7 | undefined): JSONSchema7 => {
    if (!schema || typeof schema !== "object") {
      return { type: "object", properties: {} }
    }

    if (schema.type === "object" || schema.properties) {
      return {
        ...schema,
        type: "object",
        properties: schema.properties ?? {},
      }
    }

    return {
      type: "object",
      properties: {
        value: schema,
      },
      required: ["value"],
    }
  }

  return (agent.tools || []).map((tool) => {
    const schemaParameters = tool.schema.parameters as SchemaWithRawJson
    const rawSchema = schemaParameters.__xyne_raw_json_schema

    let inputSchema: JSONSchema7

    if (rawSchema && typeof rawSchema === "object") {
      // Use pre-converted JSON schema if available
      inputSchema = ensureObjectSchema(rawSchema as JSONSchema7)
    } else {
      // Convert Zod schema to JSON schema
      try {
        // Cast the Zod schema to the expected type for conversion
        const zodSchema = tool.schema.parameters as any
        const convertedSchema = zodSchemaToJsonSchema(zodSchema) as JSONSchema7
        inputSchema = ensureObjectSchema(convertedSchema)
      } catch (error) {
        console.warn(
          `Failed to convert Zod schema to JSON for tool ${tool.schema.name}:`,
          error,
        )
        // Fallback to empty object schema
        inputSchema = { type: "object", properties: {} }
      }
    }

    return {
      type: "function" as const,
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema,
    }
  })
}

const buildPromptFromMessages = (
  messages: ReadonlyArray<JAFMessage>,
  systemInstruction: string,
): LanguageModelV2Message[] => {
  const prompt: LanguageModelV2Message[] = []
  const toolNameById = new Map<string, string>()

  prompt.push({ role: "system", content: systemInstruction })

  for (const message of messages) {
    if (message.role === "user") {
      const text = getTextContent(message.content) || ""
      prompt.push({
        role: "user",
        content: [{ type: "text", text }],
      })
      continue
    }

    if (message.role === "assistant") {
      const parts: Array<
        | LanguageModelV2TextPart
        | LanguageModelV2FilePart
        | LanguageModelV2ReasoningPart
        | LanguageModelV2ToolCallPart
        | LanguageModelV2ToolResultPart
      > = []
      const text = getTextContent(message.content)
      if (text) {
        parts.push({ type: "text", text })
      }

      for (const toolCall of message.tool_calls ?? []) {
        toolNameById.set(toolCall.id, toolCall.function.name)

        const rawArgs = toolCall.function.arguments
        let parsedArgs: JSONValue = {}
        if (typeof rawArgs === "string") {
          try {
            const maybeParsed = JSON.parse(rawArgs)
            if (maybeParsed && typeof maybeParsed === "object") {
              parsedArgs = maybeParsed as JSONValue
            }
          } catch {
            // keep default empty object if parsing fails
          }
        } else if (rawArgs && typeof rawArgs === "object") {
          parsedArgs = rawArgs as JSONValue
        }

        parts.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: parsedArgs,
        })
      }

      if (parts.length > 0) {
        prompt.push({
          role: "assistant",
          content: parts,
        })
      }
      continue
    }

    if (message.role === "tool") {
      const toolCallId = (message as { tool_call_id?: string }).tool_call_id
      if (!toolCallId) {
        continue
      }

      const toolName = toolNameById.get(toolCallId) ?? "unknown"
      const output = createToolResultOutput(message)
      prompt.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            output,
          },
        ],
      })
    }
  }

  return prompt
}

const createToolResultOutput = (
  message: JAFMessage,
): LanguageModelV2ToolResultOutput => {
  const raw = getTextContent(message.content)
  if (!raw) {
    return { type: "text", value: "" }
  }

  const parsed = safeParseJson(raw)
  if (typeof parsed === "string") {
    return { type: "text", value: parsed }
  }

  if (
    parsed === null ||
    typeof parsed === "number" ||
    typeof parsed === "boolean" ||
    Array.isArray(parsed) ||
    typeof parsed === "object"
  ) {
    return { type: "json", value: parsed as JSONValue }
  }

  return { type: "text", value: raw }
}

const convertResultToJAFMessage = (
  content: Array<LanguageModelV2Content>,
): {
  content: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
} => {
  const textSegments = content
    .filter(
      (part): part is Extract<LanguageModelV2Content, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)

  let aggregatedText = textSegments.join("\n")

  if (!aggregatedText) {
    const toolResult = content.find(
      (
        part,
      ): part is Extract<LanguageModelV2Content, { type: "tool-result" }> =>
        part.type === "tool-result",
    )
    if (toolResult) {
      const resultValue = toolResult.result
      aggregatedText =
        typeof resultValue === "string"
          ? resultValue
          : JSON.stringify(resultValue ?? {})
    }
  }

  const toolCalls = content
    .filter(
      (part): part is LanguageModelV2ToolCall => part.type === "tool-call",
    )
    .map((part) => ({
      id: part.toolCallId,
      type: "function" as const,
      function: {
        name: part.toolName,
        arguments:
          typeof part.input === "string"
            ? part.input
            : JSON.stringify(part.input ?? {}),
      },
    }))

  return {
    content: aggregatedText || "",
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  }
}

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
