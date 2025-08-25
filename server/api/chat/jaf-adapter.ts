import { z } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolResponse } from "@xynehq/jaf"
import type { MinimalAgentFragment } from "./types"
import { agentTools } from "./tools"
import type { AgentTool } from "./types"
import { answerContextMapFromFragments } from "@/ai/context"

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

function paramsToZod(parameters: Record<string, AgentToolParameter>): z.ZodObject<any> {
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
        schema = z.any()
        break
      default:
        schema = z.any()
    }
    if (!spec.required) schema = schema.optional()
    shape[key] = schema.describe(spec.description || "")
  }
  return z.object(shape)
}

export function buildInternalJAFTools(baseCtx: JAFAdapterCtx): Tool<any, JAFAdapterCtx>[] {
  const tools: Tool<any, JAFAdapterCtx>[] = []
  for (const [name, at] of Object.entries(agentTools)) {
    tools.push({
      schema: {
        name,
        description: at.description,
        parameters: paramsToZod(at.parameters || {}),
      },
      async execute(args, context) {
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

export function buildMCPJAFTools(finalTools: FinalToolsList): Tool<any, JAFAdapterCtx>[] {
  const tools: Tool<any, JAFAdapterCtx>[] = []
  for (const [connectorId, info] of Object.entries(finalTools)) {
    for (const t of info.tools) {
      const toolName = t.toolName
      tools.push({
        schema: {
          name: toolName,
          description: `MCP tool from connector ${connectorId}`,
          // Keep permissive for now; advanced: infer from toolSchema JSON
          parameters: z.any(),
        },
        async execute(args, context) {
          try {
            const mcpResp = await info.client.callTool({ name: toolName, arguments: args })
            let formattedContent = "Tool executed successfully."
            const newFragments: MinimalAgentFragment[] = []

            // Best-effort parse of MCP response content
            try {
              const content = mcpResp?.content?.[0]?.text
              if (typeof content === "string" && content.trim().length > 0) {
                formattedContent = content
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
            return ToolResponse.error("EXECUTION_FAILED", `MCP tool ${toolName} failed: ${err?.message || String(err)}`, { connectorId })
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

export function buildContextSection(fragments: MinimalAgentFragment[], maxItems = 12): string {
  if (!fragments || fragments.length === 0) return ""
  const ctx = answerContextMapFromFragments(fragments.slice(0, maxItems), maxItems)
  return `\n\nContext Fragments (use [n] to cite):\n${ctx}`
}

