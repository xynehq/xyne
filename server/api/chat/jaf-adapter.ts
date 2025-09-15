import { z } from "zod"
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

function paramsToZod(
  parameters: Record<string, AgentToolParameter>,
): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, spec] of Object.entries(parameters || {})) {
    let schema: z.ZodTypeAny
    switch ((spec.type || "string").toLowerCase()) {
      case "string":
        schema = z.string()
        break
      case "number":
        schema = z.number()
        break
      case "boolean":
        schema = z.boolean()
        break
      case "array":
        schema = z.array(z.any())
        break
      case "object":
        // Ensure top-level parameter properties that are objects are valid JSON Schema objects
        schema = z.object({}).passthrough()
        break
      default:
        schema = z.any()
    }
    if (!spec.required) schema = schema.optional()
    shape[key] = schema.describe(spec.description || "")
  }
  return z.object(shape)
}

function mcpToolSchemaStringToZodObject(schemaStr?: string | null): z.AnyZodObject {
  // Simplified and safe: bypass JSON->Zod conversion to avoid recursive $defs hangs.
  // Attach the raw JSON schema so downstream provider can use it directly.
  if (!schemaStr) return z.object({}).passthrough()
  try {
    const parsed = JSON.parse(schemaStr)
    const inputSchema = parsed?.inputSchema || parsed?.parameters || parsed
    const obj = z.object({}).passthrough()
    ;(obj as any).__xyne_raw_json_schema = inputSchema
    return obj
  } catch {
    return z.object({}).passthrough()
  }
}

export function buildInternalJAFTools(): Tool<any, JAFAdapterCtx>[] {
  const tools: Tool<any, JAFAdapterCtx>[] = []
  for (const [name, at] of Object.entries(agentTools)) {
    // Skip the fallbackTool as it's no longer needed
    if (name === "fall_back" || name === "get_user_info") {
      continue
    }

    tools.push({
      schema: {
        name,
        description: at.description,
        parameters: paramsToZod(at.parameters || {}) as any,
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
        } catch (err: any) {
          return ToolResponse.error(
            "EXECUTION_FAILED",
            `Internal tool ${name} failed: ${err?.message || String(err)}`,
          )
        }
      },
    })
  }
  return tools
}

export type MCPToolClient = {
  callTool: (args: { name: string; arguments: any }) => Promise<any>
  close?: () => Promise<void>
}

export type FinalToolsList = Record<
  string,
  {
    tools: Array<{ toolName: string; toolSchema?: string | null }>
    client: MCPToolClient
  }
>

export function buildMCPJAFTools(
  finalTools: FinalToolsList,
): Tool<any, JAFAdapterCtx>[] {
  const tools: Tool<any, JAFAdapterCtx>[] = []
  for (const [connectorId, info] of Object.entries(finalTools)) {
    for (const t of info.tools) {
      const toolName = t.toolName
      // Prefer DB description; else try schema description; fallback to generic
      let toolDescription: string | undefined = (t as any).description || undefined
      if (!toolDescription && t.toolSchema) {
        try {
          const parsed = JSON.parse(t.toolSchema)
          toolDescription = parsed?.description || parsed?.inputSchema?.description
        } catch {}
      }
      try {
        Logger.info({ connectorId, toolName, descLen: (toolDescription || "").length }, "[MCP] Registering tool for JAF agent")
      } catch {}
      tools.push({
        schema: {
          name: toolName,
          description: toolDescription || `MCP tool from connector ${connectorId}`,
          // Parse MCP tool JSON schema; ensure an OBJECT at top-level for Vertex/Gemini
          parameters: mcpToolSchemaStringToZodObject(t.toolSchema) as any,
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
              const content = mcpResp?.content?.[0]?.text
              if (typeof content === "string" && content.trim().length > 0) {
                formattedContent = content
              }
              // Opportunistically forward contexts if MCP server provides them
              const maybeContexts =
                mcpResp?.metadata?.contexts ??
                mcpResp?.contexts ??
                mcpResp?.data?.contexts
              if (Array.isArray(maybeContexts)) {
                newFragments = maybeContexts as MinimalAgentFragment[]
              }
            } catch {
              // ignore
            }

            return ToolResponse.success(formattedContent, {
              toolName,
              contexts: newFragments,
              connectorId,
            })
          } catch (err: any) {
            return ToolResponse.error(
              "EXECUTION_FAILED",
              `MCP tool ${toolName} failed: ${err?.message || String(err)}`,
              { connectorId },
            )
          }
        },
      })
    }
  }
  return tools
}

export function buildToolsOverview(tools: Tool<any, any>[]): string {
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
