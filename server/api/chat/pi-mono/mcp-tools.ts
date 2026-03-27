/**
 * MCP Tools Adapter for Pi-Mono
 *
 * Converts MCP connector tools to pi-mono ToolDefinition format
 * Handles MCP virtual agent execution
 */

import { Type, type TSchema, type Static } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import { getProviderByModel } from "@/ai/provider"
import { Models, type ModelParams } from "@/ai/types"
import { ConversationRole, type Message } from "@aws-sdk/client-bedrock-runtime"
import type { XyneToolContext, XyneAgentState } from "./adapter"
import type { ToolOutput } from "@/api/chat/tool-schemas"
import type { Citation, MinimalAgentFragment } from "@/api/chat/types"
import { Apps } from "@xyne/vespa-ts/types"
import config from "@/config"

const { defaultFastModel, defaultBestModel } = config

/**
 * MCP Tool Client interface
 */
export interface MCPToolClient {
  callTool: (args: { name: string; arguments: unknown }) => Promise<unknown>
  close?: () => Promise<void>
}

/**
 * MCP Tool Definition
 */
export interface MCPToolDefinition {
  toolName: string
  toolSchema?: string | null
  description?: string
}

/**
 * MCP Virtual Agent Runtime
 */
export interface MCPVirtualAgentRuntime {
  agentId: string
  connectorId: string
  connectorName?: string
  description?: string
  tools: MCPToolDefinition[]
  client: MCPToolClient
}

/**
 * Convert JSON Schema to TypeBox schema
 * Handles MCP tool schema conversion for pi-mono
 */
export function convertJsonSchemaToTypeBox(schemaStr?: string | null): TSchema {
  if (!schemaStr) {
    return Type.Object({})
  }

  try {
    const parsed = JSON.parse(schemaStr)
    const inputSchema = parsed?.inputSchema || parsed?.parameters || parsed

    // Convert JSON schema properties to TypeBox
    if (inputSchema?.properties && typeof inputSchema.properties === "object") {
      const properties: Record<string, TSchema> = {}
      const required = new Set(inputSchema.required || [])

      for (const [key, prop] of Object.entries(inputSchema.properties)) {
        properties[key] = jsonSchemaPropertyToTypeBox(
          prop as any,
          required.has(key),
        )
      }

      if (required.size > 0) {
        return Type.Object(properties)
      } else {
        return Type.Partial(Type.Object(properties))
      }
    }

    return Type.Object({})
  } catch (error) {
    console.warn("Failed to parse MCP tool schema:", error)
    return Type.Object({})
  }
}

/**
 * Convert a single JSON schema property to TypeBox
 */
function jsonSchemaPropertyToTypeBox(prop: any, isRequired: boolean): TSchema {
  const type = prop?.type || "string"

  let schema: TSchema

  switch (type) {
    case "string":
      schema = Type.String({
        description: prop.description,
        default: prop.default,
      })
      break
    case "number":
    case "integer":
      schema = Type.Number({
        description: prop.description,
        default: prop.default,
      })
      break
    case "boolean":
      schema = Type.Boolean({
        description: prop.description,
        default: prop.default,
      })
      break
    case "array":
      schema = Type.Array(
        prop.items ? jsonSchemaPropertyToTypeBox(prop.items, true) : Type.Any(),
        {
          description: prop.description,
          default: prop.default,
        },
      )
      break
    case "object":
      if (prop.properties) {
        const nestedProps: Record<string, TSchema> = {}
        for (const [key, val] of Object.entries(prop.properties)) {
          nestedProps[key] = jsonSchemaPropertyToTypeBox(val as any, true)
        }
        schema = Type.Object(nestedProps, {
          description: prop.description,
        })
      } else {
        schema = Type.Record(Type.String(), Type.Any(), {
          description: prop.description,
        })
      }
      break
    default:
      schema = Type.Any({
        description: prop.description,
      })
  }

  // Handle enum
  if (prop.enum && Array.isArray(prop.enum)) {
    schema = Type.Union(
      prop.enum.map((v: any) =>
        typeof v === "string" ? Type.Literal(v) : Type.Literal(String(v)),
      ),
      { description: prop.description },
    )
  }

  // Make optional if not required
  if (!isRequired) {
    return Type.Optional(schema)
  }

  return schema
}

/**
 * MCP Tool Response types
 */
interface MCPResponse {
  content?: Array<{ type?: string; text?: string }>
  metadata?: { contexts?: unknown }
  contexts?: unknown
  data?: { contexts?: unknown; result?: string }
  result?: string
  isError?: boolean
}

/**
 * Execute an MCP tool and format the result
 */
export async function executeMcpTool(
  toolName: string,
  connectorId: string,
  connectorName: string,
  client: MCPToolClient,
  args: Record<string, unknown>,
): Promise<{ content: string; fragments: MinimalAgentFragment[] }> {
  try {
    const mcpResp = (await client.callTool({
      name: toolName,
      arguments: args,
    })) as MCPResponse

    let formattedContent = "Tool executed successfully."
    const fragments: MinimalAgentFragment[] = []

    // Extract content from response
    const content = mcpResp?.content?.[0]?.text
    if (typeof content === "string" && content.trim().length > 0) {
      formattedContent = content
    } else if (typeof mcpResp?.result === "string") {
      formattedContent = mcpResp.result
    } else if (typeof mcpResp?.data?.result === "string") {
      formattedContent = mcpResp.data.result
    }

    // Extract contexts/fragments if provided
    const maybeContexts =
      mcpResp?.metadata?.contexts ??
      mcpResp?.contexts ??
      mcpResp?.data?.contexts

    if (Array.isArray(maybeContexts)) {
      fragments.push(...(maybeContexts as MinimalAgentFragment[]))
    }

    // Create synthetic fragment if none provided
    if (fragments.length === 0 && formattedContent) {
      const syntheticSource: Citation = {
        docId: connectorId,
        title: connectorName || `Connector ${connectorId}`,
        url: "",
        app: Apps.MCP,
        entity: {
          type: "mcp",
          connectorId,
          name: connectorName || connectorId,
        } as unknown as Citation["entity"],
      }
      const syntheticId = `${connectorId}:${toolName}:${Date.now()}`
      fragments.push({
        id: syntheticId,
        content: formattedContent,
        source: syntheticSource,
        confidence: 0.7,
      })
    }

    return { content: formattedContent, fragments }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    throw new Error(`MCP tool ${toolName} failed: ${errorMsg}`)
  }
}

/**
 * Build MCP tools for pi-mono customTools
 */
export function buildMcpCustomTools(
  finalTools: Record<
    string,
    {
      tools: MCPToolDefinition[]
      client: MCPToolClient
      metadata?: { name?: string; description?: string }
    }
  >,
): ToolDefinition<any, any>[] {
  const tools: ToolDefinition<any, any>[] = []

  for (const [connectorId, info] of Object.entries(finalTools)) {
    for (const t of info.tools) {
      const toolName = t.toolName
      const connectorName = info.metadata?.name || `Connector ${connectorId}`

      // Parse description from schema if not provided
      let toolDescription = t.description
      if (!toolDescription && t.toolSchema) {
        try {
          const parsed = JSON.parse(t.toolSchema)
          toolDescription =
            parsed?.description || parsed?.inputSchema?.description
        } catch {
          // ignore
        }
      }

      tools.push({
        name: toolName,
        label: `MCP: ${toolName}`,
        description: toolDescription || `MCP tool from ${connectorName}`,
        parameters: convertJsonSchemaToTypeBox(t.toolSchema),
        execute: async (
          toolCallId: string,
          params: Record<string, unknown>,
          signal: AbortSignal | undefined,
          onUpdate: any,
          extCtx: any,
        ) => {
          const { content, fragments } = await executeMcpTool(
            toolName,
            connectorId,
            connectorName,
            info.client,
            params,
          )

          return {
            content: [{ type: "text", text: content }],
            details: {
              toolName,
              connectorId,
              fragments,
            },
          }
        },
      })
    }
  }

  return tools
}

/**
 * Select MCP tools using LLM
 */
export async function selectMcpToolsWithLlm(
  query: string,
  tools: MCPToolDefinition[],
  modelId: string = (defaultFastModel as Models) ||
    (defaultBestModel as Models),
): Promise<
  Array<{
    toolName: string
    arguments: Record<string, unknown>
    rationale?: string
  }>
> {
  const toolList = tools
    .map(
      (t, idx) =>
        `${idx + 1}. ${t.toolName} - ${t.description || "No description"}`,
    )
    .join("\n")

  const systemPrompt = [
    "You are orchestrating MCP tools to satisfy the user query.",
    "Return strict JSON: {tools:[{toolName, arguments, rationale}, ...]}.",
    "Include at least one tool; order by execution priority; keep arguments concise and schema-aligned.",
    "If absolutely unable to structure an array, fall back to a single object, but prefer the array shape.",
  ].join(" ")

  const payload = [
    `User query:\n${query}`,
    `Available MCP tools (${tools.length}):\n${toolList}`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const messages: Message[] = [
    {
      role: ConversationRole.USER,
      content: [{ text: payload }],
    },
  ]

  const modelParams: ModelParams = {
    modelId,
    json: true,
    stream: false,
    temperature: 0,
    max_new_tokens: 1200,
    systemPrompt,
  }

  const toolSchema = {
    name: "select_mcp_tools",
    description: "Select and parametrize MCP tools to satisfy the query",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: {
            type: "object",
            properties: {
              toolName: { type: "string" },
              arguments: { type: "object" },
              rationale: { type: "string" },
            },
            required: ["toolName", "arguments"],
          },
        },
      },
      required: ["tools"],
    },
  }

  try {
    const provider = getProviderByModel(modelId)
    const selectionResponse = await provider.converse(messages, {
      ...modelParams,
      tools: [toolSchema],
      tool_choice: "select_mcp_tools" as any,
    })

    const responseToolCalls =
      selectionResponse.tool_calls ?? (selectionResponse as any)?.toolCalls

    const calls = Array.isArray(responseToolCalls)
      ? responseToolCalls.map((tc: any) => ({
          toolName: tc.name ?? tc.function?.name ?? tc.toolName,
          arguments: (() => {
            const rawArgs =
              tc.arguments ?? tc.function?.arguments ?? tc.args ?? "{}"
            if (typeof rawArgs === "object" && rawArgs !== null) {
              return rawArgs as Record<string, unknown>
            }
            if (typeof rawArgs === "string") {
              try {
                return JSON.parse(rawArgs)
              } catch {
                return {}
              }
            }
            return {}
          })(),
          rationale: tc.rationale ?? tc.reason,
        }))
      : null

    if (calls && calls.length > 0) {
      return calls.filter((c: any) => c.toolName)
    }
  } catch (error) {
    console.warn("LLM MCP tool selection failed:", error)
  }

  // Fallback: select first tool with empty args
  if (tools.length > 0) {
    return [
      {
        toolName: tools[0].toolName,
        arguments: {},
        rationale: "Heuristic default selection (LLM failed)",
      },
    ]
  }

  return []
}

/**
 * Execute MCP virtual agent
 */
export async function executeMcpVirtualAgent(
  agentId: string,
  query: string,
  options: {
    mcpAgents: MCPVirtualAgentRuntime[]
    userEmail: string
    maxTokens?: number
  },
): Promise<ToolOutput> {
  const connectorId = agentId.replace(/^mcp:/, "")
  const mcpAgent = options.mcpAgents.find(
    (a) => a.agentId === agentId || a.connectorId === connectorId,
  )

  if (!mcpAgent) {
    return {
      result: "MCP agent not available for this request",
      error: "UNKNOWN_MCP_AGENT",
      metadata: { agentId },
    }
  }

  if (!mcpAgent.client) {
    return {
      result: "MCP agent client is not initialized",
      error: "MCP_CLIENT_UNAVAILABLE",
      metadata: { agentId },
    }
  }

  // Select tools using LLM
  const selectedTools = await selectMcpToolsWithLlm(
    query,
    mcpAgent.tools,
    defaultFastModel as Models,
  )

  if (selectedTools.length === 0) {
    return {
      result: "No MCP tools could be selected for this query",
      error: "MCP_TOOL_SELECTION_FAILED",
      metadata: { agentId, connectorId },
    }
  }

  // Execute selected tools
  const executions: Array<{
    toolName: string
    arguments: Record<string, unknown>
    result: string
    rationale?: string
    fragments: MinimalAgentFragment[]
  }> = []

  const availableTools = new Map<string, MCPToolDefinition>()
  mcpAgent.tools.forEach((t) => availableTools.set(t.toolName, t))

  // Limit to 3 tools for safety
  const executionList = selectedTools
    .filter((entry) => availableTools.has(entry.toolName))
    .slice(0, 3)

  for (const entry of executionList) {
    try {
      const { content, fragments } = await executeMcpTool(
        entry.toolName,
        connectorId,
        mcpAgent.connectorName || `Connector ${connectorId}`,
        mcpAgent.client,
        entry.arguments,
      )

      executions.push({
        toolName: entry.toolName,
        arguments: entry.arguments,
        result: content,
        rationale: entry.rationale,
        fragments,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      executions.push({
        toolName: entry.toolName,
        arguments: entry.arguments,
        result: `Error: ${errorMsg}`,
        rationale: entry.rationale,
        fragments: [],
      })
    }
  }

  // Format result
  const formattedPieces = executions.map((exec) => exec.result)
  const formattedContent =
    formattedPieces.length === 1
      ? formattedPieces[0]
      : formattedPieces.join("\n\n")

  // Collect all fragments
  const allFragments = executions.flatMap((e) => e.fragments)

  return {
    result: formattedContent,
    contexts: allFragments.map((f) => ({
      id: f.id,
      content: f.content,
      source: f.source,
      confidence: f.confidence,
    })),
    metadata: {
      agentId,
      connectorId,
      toolName: executions[0]?.toolName,
      rationale: executions[0]?.rationale,
      requestedTools: executions.map((exec) => ({
        toolName: exec.toolName,
        arguments: exec.arguments,
        rationale: exec.rationale,
      })),
    },
  }
}

/**
 * Build MCP virtual agents from connectors that exceed tool budget
 */
export function buildMcpVirtualAgents(
  agentConnectorIds: Set<string>,
  finalToolsMap: Record<
    string,
    {
      tools: MCPToolDefinition[]
      client: MCPToolClient
      metadata?: { name?: string; description?: string }
    }
  >,
): MCPVirtualAgentRuntime[] {
  const virtualAgents: MCPVirtualAgentRuntime[] = []

  for (const connectorId of agentConnectorIds) {
    const entry = finalToolsMap[connectorId]
    if (!entry) continue

    virtualAgents.push({
      agentId: `mcp:${connectorId}`,
      connectorId,
      connectorName: entry.metadata?.name || `Connector ${connectorId}`,
      description:
        entry.metadata?.description ||
        `MCP agent wrapping ${entry.tools.length} tool${entry.tools.length === 1 ? "" : "s"}`,
      tools: entry.tools,
      client: entry.client,
    })
  }

  return virtualAgents
}
