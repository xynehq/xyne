import { z, type ZodRawShape, type ZodType } from "zod"
import type { JSONSchema7 } from "json-schema"
import type { Tool } from "@xynehq/jaf"
import { ToolResponse } from "@xynehq/jaf"
import type { MinimalAgentFragment } from "./types"
import { agentTools } from "./tools"
import { answerContextMapFromFragments } from "@/ai/context"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat).child({ module: "jaf-adapter" })

export type JAFAdapterCtx = {
  email: string
  userCtx: string
  agentPrompt?: string
  userMessage: string
}

type AgentToolParameter = {
  type: string
  description: string
  required: boolean
}

type ToolSchemaParameters = Tool<unknown, JAFAdapterCtx>["schema"]["parameters"]

const toToolSchemaParameters = (schema: ZodType): ToolSchemaParameters =>
  schema as unknown as ToolSchemaParameters

function paramsToZod(
  parameters: Record<string, AgentToolParameter>,
): ToolSchemaParameters {
  if (!parameters || Object.keys(parameters).length === 0) {
    return toToolSchemaParameters(z.looseObject({}))
  }

  const shape: Record<string, ZodType> = {}
  const jsonProperties: NonNullable<JSONSchema7["properties"]> = {}
  const requiredKeys: string[] = []

  for (const [key, spec] of Object.entries(parameters)) {
    const normalizedType = (spec.type || "string").toLowerCase()

    let schema: ZodType
    let jsonSchema: JSONSchema7

    switch (normalizedType) {
      case "string": {
        schema = z.string()
        jsonSchema = { type: "string" }
        break
      }
      case "number": {
        schema = z.number()
        jsonSchema = { type: "number" }
        break
      }
      case "boolean": {
        schema = z.boolean()
        jsonSchema = { type: "boolean" }
        break
      }
      case "array": {
        schema = z.array(z.unknown())
        jsonSchema = { type: "array", items: {} }
        break
      }
      case "object": {
        schema = z.looseObject({})
        jsonSchema = { type: "object" }
        break
      }
      default: {
        schema = z.unknown()
        jsonSchema = {}
        break
      }
    }

    const described = schema.describe(spec.description || "")
    shape[key] = spec.required ? described : described.optional()

    if (spec.description) {
      jsonSchema.description = spec.description
    }
    jsonProperties[key] = jsonSchema
    if (spec.required) {
      requiredKeys.push(key)
    }
  }

  const looseObject = z.looseObject(shape as unknown as ZodRawShape) as unknown as ZodObjectWithRawSchema

  const jsonSchema: JSONSchema7 = {
    type: "object",
    properties: jsonProperties,
    additionalProperties: false,
  }
  if (requiredKeys.length > 0) {
    jsonSchema.required = requiredKeys
  }

  looseObject.__xyne_raw_json_schema = jsonSchema

  return toToolSchemaParameters(looseObject)
}

type ZodObjectWithRawSchema = ZodType & {
  __xyne_raw_json_schema?: unknown
}

function mcpToolSchemaStringToZodObject(
  schemaStr?: string | null,
): ToolSchemaParameters {
  // Simplified and safe: bypass JSON->Zod conversion to avoid recursive $defs hangs.
  // Attach the raw JSON schema so downstream provider can use it directly.
  if (!schemaStr) return toToolSchemaParameters(z.looseObject({}))
  try {
    const parsed = JSON.parse(schemaStr)
    const inputSchema = parsed?.inputSchema || parsed?.parameters || parsed
    const obj = z.looseObject({}) as unknown as ZodObjectWithRawSchema
    obj.__xyne_raw_json_schema = inputSchema
    return toToolSchemaParameters(obj)
  } catch (error) {
    Logger.error({ err: error, schemaStr }, "Failed to parse MCP tool schema string");
    return toToolSchemaParameters(z.looseObject({}))
  }
}

export function buildInternalJAFTools(): Tool<unknown, JAFAdapterCtx>[] {
  const tools: Tool<unknown, JAFAdapterCtx>[] = []
  for (const [name, at] of Object.entries(agentTools)) {
    // Skip the fallbackTool as it's no longer needed
    if (name === "fall_back" || name === "get_user_info") {
      continue
    }

    tools.push({
      schema: {
        name,
        description: at.description,
        parameters: paramsToZod(at.parameters || {})
      },
      async execute(args, context) {
        try {
          // Delegate to existing agent tool implementation
          const res = await at.execute(
            args,
            undefined,
            context.email,
            context.userCtx,
            context.agentPrompt,
            context.userMessage,
          )
          // Normalize to JAF ToolResult while keeping summary string as data
          const summary = res?.result ?? ""
          const contexts = res?.contexts ?? []
          return ToolResponse.success(summary, {
            toolName: name,
            contexts,
          })
        } catch (err) { 
           return ToolResponse.error( 
             "EXECUTION_FAILED", 
              `Internal tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, 
            ) 
        }
      },
    })
  }
  return tools
}

export type MCPToolClient = {
  callTool: (args: { name: string; arguments: unknown }) => Promise<unknown>
  close?: () => Promise<void>
}

interface MCPToolItem {
  toolName: string
  toolSchema?: string | null
  description?: string
}

export type FinalToolsList = Record<
  string,
  {
    tools: Array<MCPToolItem>
    client: MCPToolClient
  }
>

export function buildMCPJAFTools(finalTools: FinalToolsList): Tool<unknown, JAFAdapterCtx>[] {
  const tools: Tool<unknown, JAFAdapterCtx>[] = []
  for (const [connectorId, info] of Object.entries(finalTools)) {
    for (const t of info.tools) {
      const toolName = t.toolName
      // Prefer DB description; else try schema description; fallback to generic
      let toolDescription: string | undefined = t.description || undefined
      if (!toolDescription && t.toolSchema) {
        try {
          const parsed = JSON.parse(t.toolSchema)
          toolDescription = parsed?.description || parsed?.inputSchema?.description
        } catch(error) {
          Logger.warn({ err: error, toolName }, "Could not parse toolSchema to extract description");
        }
      }
      Logger.info({ connectorId, toolName, descLen: (toolDescription || "").length }, "[MCP] Registering tool for JAF agent")
      tools.push({
        schema: {
          name: toolName,
          description: toolDescription || `MCP tool from connector ${connectorId}`,
          // Parse MCP tool JSON schema; ensure an OBJECT at top-level for Vertex/Gemini
          parameters: mcpToolSchemaStringToZodObject(t.toolSchema),
        },
        async execute(args, context) {
          try {
            const mcpResp = await info.client.callTool({
              name: toolName,
              arguments: args,
            })
            let formattedContent = "Tool executed successfully."
            let newFragments: MinimalAgentFragment[] = []

            // Best-effort parse of MCP response content
            try {
              interface MCPResponse {
                content?: Array<{ text?: string }>
                metadata?: { contexts?: unknown }
                contexts?: unknown
                data?: { contexts?: unknown }
              }
              const resp = mcpResp as MCPResponse
              const content = resp?.content?.[0]?.text
              if (typeof content === "string" && content.trim().length > 0) {
                formattedContent = content
              }
              // Opportunistically forward contexts if MCP server provides them
              const maybeContexts =
                resp?.metadata?.contexts ??
                resp?.contexts ??
                resp?.data?.contexts
              if (Array.isArray(maybeContexts)) {
                newFragments = maybeContexts as MinimalAgentFragment[]
              }
            } catch (error) {
              Logger.warn({ err: error, toolName }, "Could not parse MCP tool response");
            }

            return ToolResponse.success(formattedContent, {
              toolName,
              contexts: newFragments,
              connectorId,
            })
          } catch (err) {
            return ToolResponse.error("EXECUTION_FAILED", `MCP tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`, { connectorId })
          }
        },
      })
    }
  }
  return tools
}

export function buildToolsOverview<A = unknown, Ctx = unknown>(tools: Tool<A, Ctx>[]): string {
  if (!tools || tools.length === 0) return "No tools available."
  return tools
    .map((t, idx) => `  ${idx + 1}. ${t.schema.name}: ${t.schema.description}`)
    .join("\n")
}

export function buildContextSection(
  fragments: MinimalAgentFragment[],
  maxItems = 12,
): string {
  if (!fragments || fragments.length === 0) return ""
  const ctx = answerContextMapFromFragments(
    fragments.slice(0, maxItems),
    maxItems,
  )
  return `\n\nContext Fragments (use [n] to cite):\n${ctx}`
}
