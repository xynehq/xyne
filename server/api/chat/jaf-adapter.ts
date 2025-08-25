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

// --- MCP JSON Schema -> Zod conversion ---
// Accepts MCP tool schema JSON (string) and attempts to construct a Zod object
// for the function parameters. If parsing fails, returns a permissive object.
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any()

  const t = schema.type
  if (Array.isArray(t)) {
    // Prefer object if available, else union
    if (t.includes("object")) return jsonSchemaToZod({ ...schema, type: "object" })
    const opts = t.map((tt) => jsonSchemaToZod({ ...schema, type: tt }))
    if (opts.length >= 2) {
      const [a, b, ...rest] = opts
      return z.union([a, b, ...rest] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
    }
    return opts[0] ?? z.any()
  }

  switch (t) {
    case "string": {
      if (Array.isArray(schema.enum) && schema.enum.length) {
        const literals = schema.enum
        // z.enum only supports string enums; fallback to union otherwise
        if (literals.every((v: any) => typeof v === "string")) {
          return z.enum(literals as [string, ...string[]])
        }
        return z.union(literals.map((v: any) => z.literal(v)))
      }
      return z.string()
    }
    case "integer":
      return z.number().int()
    case "number":
      return z.number()
    case "boolean":
      return z.boolean()
    case "null":
      return z.null()
    case "array": {
      const items = schema.items ? jsonSchemaToZod(schema.items) : z.any()
      return z.array(items)
    }
    case "object": {
      const props = schema.properties || {}
      const required: string[] = Array.isArray(schema.required)
        ? schema.required
        : []
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, propSchema] of Object.entries<any>(props)) {
        const zodProp = jsonSchemaToZod(propSchema)
        shape[key] = required.includes(key) ? zodProp : zodProp.optional()
      }
      // Allow additional properties to pass through to the tool call
      let obj: z.AnyZodObject = z.object(shape)
      if (schema.additionalProperties) {
        // If additionalProperties is a schema, try to honor it; else allow any
        if (typeof schema.additionalProperties === "object") {
          obj = obj.catchall(jsonSchemaToZod(schema.additionalProperties))
        } else {
          obj = obj.catchall(z.any())
        }
      } else {
        obj = obj.passthrough()
      }
      return obj
    }
    default:
      // Handle combinators if present
      if (Array.isArray(schema.anyOf)) {
        const opts = schema.anyOf.map((s: any) => jsonSchemaToZod(s))
        if (opts.length >= 2) {
          const [a, b, ...rest] = opts
          return z.union([a, b, ...rest] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        }
        return opts[0] ?? z.any()
      }
      if (Array.isArray(schema.oneOf)) {
        const opts = schema.oneOf.map((s: any) => jsonSchemaToZod(s))
        if (opts.length >= 2) {
          const [a, b, ...rest] = opts
          return z.union([a, b, ...rest] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        }
        return opts[0] ?? z.any()
      }
      if (Array.isArray(schema.allOf)) {
        // Approximate allOf via intersection; zod doesn't have variadic intersection, fold it
        const parts = schema.allOf.map((s: any) => jsonSchemaToZod(s))
        if (!parts.length) return z.any()
        if (parts.length === 1) return parts[0]
        let acc: z.ZodTypeAny = parts[0] as z.ZodTypeAny
        for (let i = 1; i < parts.length; i++) {
          acc = z.intersection(acc, parts[i])
        }
        return acc
      }
      return z.any()
  }
}

function mcpToolSchemaStringToZodObject(schemaStr?: string | null): z.AnyZodObject {
  if (!schemaStr) return z.object({}).passthrough()
  try {
    const parsed = JSON.parse(schemaStr)
    // Some MCP servers store the whole tool object with inputSchema inside
    const inputSchema = parsed?.inputSchema || parsed?.parameters || parsed
    const zod = jsonSchemaToZod(inputSchema)
    // Ensure top-level is an object; Gemini/Vertex requires parameters to be OBJECT
    if (zod instanceof z.ZodObject) {
      return zod as z.AnyZodObject
    }
    // Fallback: wrap in an object under a generic key
    return z.object({ input: zod }).passthrough()
  } catch {
    return z.object({}).passthrough()
  }
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
          // Parse MCP tool JSON schema; ensure an OBJECT at top-level for Vertex/Gemini
          parameters: mcpToolSchemaStringToZodObject(t.toolSchema),
        },
        async execute(args, context) {
          try {
            const mcpResp = await info.client.callTool({ name: toolName, arguments: args })
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
