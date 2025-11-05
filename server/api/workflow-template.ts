import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { HTTPException } from "hono/http-exception"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { getUserFromJWT } from "@/db/user"
import { db } from "@/db/client"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowTool,
  type SelectWorkflowTemplate,
} from "@/db/schema/workflows"
import { eq, inArray, sql, and, or } from "drizzle-orm"
import { handleActivateTemplate } from "@/execution-engine/triggers"

const loggerWithChild = getLoggerWithChild(Subsystem.WorkflowApi)
const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.WorkflowApi)

// New Workflow Template API Routes
export const workflowTemplateRouter = new Hono()

import { getSupportedToolTypes, getTool, getToolCategory } from "@/workflow-tools/registry"
import { ToolType } from "@/types/workflowTypes"

// Helper function to get category from tool type - now uses the category from the tool files themselves
const getCategoryFromType = (toolType: string): string => {
  try {
    return getToolCategory(toolType as ToolType)
  } catch (error) {
    // Fallback for unknown tool types
    return "action"
  }
}

// Helper function to parse Zod schema into readable format
const parseZodSchema = (schema: any): any => {
  if (!schema || !schema.def) return schema

  const def = schema.def

  switch (def.type) {
    case "object":
      const properties: Record<string, any> = {}
      const required: string[] = []
      
      if (def.shape) {
        Object.entries(def.shape).forEach(([key, value]: [string, any]) => {
          const parsed = parseZodSchema(value)
          properties[key] = parsed
          
          // Check if field is required (not optional or has default)
          if (value?.def?.type !== "optional" && value?.def?.type !== "default") {
            required.push(key)
          }
        })
      }

      return {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      }

    case "string":
      return {
        type: "string",
        format: def.format || undefined,
        minLength: schema.minLength || undefined,
        maxLength: schema.maxLength || undefined,
      }

    case "number":
      return {
        type: "number",
        minimum: schema.minValue || undefined,
        maximum: schema.maxValue || undefined,
        isInteger: schema.isInt || false,
      }

    case "boolean":
      return { type: "boolean" }

    case "array":
      return {
        type: "array",
        items: def.type ? parseZodSchema(def.type) : undefined,
      }

    case "enum":
      return {
        type: "string",
        enum: schema.options || Object.keys(def.entries || {}),
      }

    case "optional":
      const inner = parseZodSchema(def.innerType)
      return {
        ...inner,
        optional: true,
      }

    case "default":
      const innerWithDefault = parseZodSchema(def.innerType)
      return {
        ...innerWithDefault,
        default: def.defaultValue,
      }

    case "union":
      return {
        oneOf: def.options?.map((opt: any) => parseZodSchema(opt)) || [],
      }

    default:
      return { type: def.type || "unknown" }
  }
}

// Get available tool types with their schemas
export const GetAvailableToolTypesApi = async (c: Context) => {
  try {
    const supportedToolTypes = getSupportedToolTypes()
    
    const toolsData = supportedToolTypes.map(toolType => {
      const schemas = getTool(toolType)
      
      return {
        type: toolType,
        category: getCategoryFromType(toolType),
        inputSchema: parseZodSchema(schemas.inputSchema),
        configSchema: parseZodSchema(schemas.configSchema),
      }
    })

    return c.json({
      success: true,
      data: {
        tools: toolsData,
        count: toolsData.length,
      },
      message: `Found ${toolsData.length} available workflow tools`,
    })
  } catch (error) {
    Logger.error(error, "Failed to get available workflow tools")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get specific tool type schema
export const GetToolTypeSchemaApi = async (c: Context) => {
  try {
    const toolType = c.req.param("toolType")
    
    if (!getSupportedToolTypes().includes(toolType as any)) {
      throw new HTTPException(404, {
        message: `Tool type '${toolType}' is not supported`,
      })
    }

    const schemas = getTool(toolType as any)
    
    return c.json({
      success: true,
      data: {
        type: toolType,
        category: getCategoryFromType(toolType),
        inputSchema: parseZodSchema(schemas.inputSchema),
        configSchema: parseZodSchema(schemas.configSchema),
      },
    })
  } catch (error) {
    Logger.error(error, `Failed to get schema for tool type: ${c.req.param("toolType")}`)
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Schema for creating workflow template
export const createTemplateSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(z.any()),
  connections: z.array(z.any()),
  description: z.string().optional(),
  isPublic: z.boolean().default(false),
  version: z.string().default("1.0.0"),
})

// Schema for updating workflow template
export const updateTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  nodes: z.array(z.any()).optional(),
  connections: z.array(z.any()).optional(),
  description: z.string().optional(),
  isPublic: z.boolean().optional(),
  version: z.string().optional(),
  newNodes: z.array(z.any()).optional(),
  newConnections: z.array(z.any()).optional(),
})

// Schema for deleting workflow template
export const deleteTemplateSchema = z.object({
  id: z.string().min(1),
})

// Schema for validating workflow template
export const validateTemplateSchema = z.object({
  nodes: z.array(z.any()),
  connections: z.array(z.any()),
})

// Common template response type
export const templateResponseSchema = z.object({
  template: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    version: z.string(),
    status: z.string(),
    isPublic: z.boolean(),
    userId: z.number(),
    workspaceId: z.number(),
    config: z.any(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  steps: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    type: z.string(),
    prevStepIds: z.array(z.string()).nullable(),
    nextStepIds: z.array(z.string()).nullable(),
    toolId: z.string().nullable(),
  })),
  tools: z.array(z.object({
    id: z.string(),
    category: z.string(),
    type: z.string(),
    value: z.any(),
    config: z.any(),
  })),
  connections: z.array(z.object({
    source: z.string(),
    target: z.string(),
    sourceStepId: z.string().optional(),
    targetStepId: z.string().optional(),
  })),
})

export type TemplateResponse = z.infer<typeof templateResponseSchema>

// Create workflow template API
export const CreateTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    
    const { name, nodes, connections, description, isPublic, version } = requestData

    // Validate template before creating
    const validation = await validateTemplateLogic(nodes, connections)
    if (!validation.isValid) {
      return c.json({
        success: false,
        errors: validation.warnings,
        message: `Template validation failed with ${validation.warnings.length} error(s)`,
      }, 400)
    }

    // Create the main workflow template
    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name,
        userId: user.id,
        workspaceId: user.workspaceId,
        description,
        isPublic: isPublic || false,
        version: version || "1.0.0",
        status: "draft",
        config: {},
      })
      .returning()

    // Create tools for each node (one tool per step)
    const toolIdMap = new Map<string, string>()
    
    for (const node of nodes) {
      if (node.tool) {
        const [createdTool] = await db
          .insert(workflowTool)
          .values({
            category: node.tool.category || getCategoryFromType(node.tool.type),
            type: node.tool.type,
            workspaceId: user.workspaceId,
            userId: user.id,
            value: node.tool.value || {},
            config: node.tool.config || {},
          })
          .returning()
        
        toolIdMap.set(node.name, createdTool.id)
      }
    }

    // Create step templates
    const stepIdMap = new Map<string, string>()
    
    for (const node of nodes) {
      const [createdStep] = await db
        .insert(workflowStepTemplate)
        .values({
          workflowTemplateId: template.id,
          name: node.name,
          description: node.description || "",
          type: node.type === "manual" ? "manual" : "automated",
          timeEstimate: 180,
          metadata: node.metadata || {},
          prevStepIds: [],
          nextStepIds: [],
          toolIds: toolIdMap.has(node.name) ? [toolIdMap.get(node.name)!] : [],
        })
        .returning()
      
      stepIdMap.set(node.name, createdStep.id)
    }

    // Update step relationships based on connections
    for (const connection of connections) {
      const [sourceName, targetName] = connection.split('-')
      const sourceStepId = stepIdMap.get(sourceName)
      const targetStepId = stepIdMap.get(targetName)
      
      if (sourceStepId && targetStepId) {
        // Update source step's nextStepIds
        await db
          .update(workflowStepTemplate)
          .set({
            nextStepIds: sql`array_append(${workflowStepTemplate.nextStepIds}, ${targetStepId})`,
          })
          .where(eq(workflowStepTemplate.id, sourceStepId))
        
        // Update target step's prevStepIds
        await db
          .update(workflowStepTemplate)
          .set({
            prevStepIds: sql`array_append(${workflowStepTemplate.prevStepIds}, ${sourceStepId})`,
          })
          .where(eq(workflowStepTemplate.id, targetStepId))
      }
    }

    // Get the created steps with their relationships
    const createdSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, template.id))

    // Get the created tools
    const createdTools = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.workspaceId, user.workspaceId))

    const responseData: TemplateResponse = {
      template: {
        ...template,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
      },
      steps: createdSteps.map(step => ({
        id: step.id,
        name: step.name,
        description: step.description,
        type: step.type,
        prevStepIds: step.prevStepIds,
        nextStepIds: step.nextStepIds,
        toolId: step.toolIds && step.toolIds.length > 0 ? step.toolIds[0] : null,
      })),
      tools: createdTools.filter(tool => 
        createdSteps.some(step => step.toolIds?.includes(tool.id))
      ).map(tool => ({
        id: tool.id,
        category: tool.category,
        type: tool.type,
        value: tool.value,
        config: tool.config,
      })),
      connections: connections.map((conn: string) => {
        const [sourceName, targetName] = conn.split('-')
        const sourceStep = createdSteps.find(s => s.name === sourceName)
        const targetStep = createdSteps.find(s => s.name === targetName)
        return {
          source: sourceName,
          target: targetName,
          sourceStepId: sourceStep?.id,
          targetStepId: targetStep?.id,
        }
      }),
    }

    return c.json({
      success: true,
      data: responseData,
      message: "Workflow template created successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to create workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Update workflow template API
export const UpdateTemplateApi = async (c: Context) => {
  // TODO: Add function logic
}

// Get workflow template API
export const GetTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const templateId = c.req.param("templateId")

    // Get template
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    if (!template) {
      throw new HTTPException(404, { message: "Template not found" })
    }

    // Get the steps for this template
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Get all tools used in this template
    const toolIds = steps.flatMap(step => step.toolIds || [])
    const tools = toolIds.length > 0 ? await db
      .select()
      .from(workflowTool)
      .where(inArray(workflowTool.id, toolIds))
      : []

    // Reconstruct connections from step relationships
    const connections: string[] = []
    steps.forEach(step => {
      if (step.nextStepIds && step.nextStepIds.length > 0) {
        step.nextStepIds.forEach(nextStepId => {
          const nextStep = steps.find(s => s.id === nextStepId)
          if (nextStep) {
            connections.push(`${step.name}-${nextStep.name}`)
          }
        })
      }
    })

    const responseData: TemplateResponse = {
      template: {
        ...template,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
      },
      steps: steps.map(step => ({
        id: step.id,
        name: step.name,
        description: step.description,
        type: step.type,
        prevStepIds: step.prevStepIds,
        nextStepIds: step.nextStepIds,
        toolId: step.toolIds && step.toolIds.length > 0 ? step.toolIds[0] : null,
      })),
      tools: tools.map(tool => ({
        id: tool.id,
        category: tool.category,
        type: tool.type,
        value: tool.value,
        config: tool.config,
      })),
      connections: connections.map(conn => {
        const [sourceName, targetName] = conn.split('-')
        const sourceStep = steps.find(s => s.name === sourceName)
        const targetStep = steps.find(s => s.name === targetName)
        return {
          source: sourceName,
          target: targetName,
          sourceStepId: sourceStep?.id,
          targetStepId: targetStep?.id,
        }
      }),
    }

    return c.json({
      success: true,
      data: responseData,
      message: "Template fetched successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Delete workflow template API
export const DeleteTemplateApi = async (c: Context) => {
  // TODO: Add function logic
}

// Helper function for template validation logic
export const validateTemplateLogic = async (nodes: any[], connections: string[]) => {

    // Build a graph to find disjoint workflows
    const nodeMap = new Map()
    const incomingConnections = new Set()
    const outgoingConnections = new Set()

    // Initialize node map
    nodes.forEach((node: any) => {
      nodeMap.set(node.name, {
        ...node,
        visited: false,
        hasIncoming: false,
        hasOutgoing: false
      })
    })

    // Process connections to identify incoming/outgoing relationships
    connections.forEach((conn: string) => {
      const [source, target] = conn.split('-')
      incomingConnections.add(target)
      outgoingConnections.add(source)
      
      if (nodeMap.has(source)) {
        nodeMap.get(source).hasOutgoing = true
      }
      if (nodeMap.has(target)) {
        nodeMap.get(target).hasIncoming = true
      }
    })

    // Find all disjoint workflows using DFS
    const workflows: any[][] = []
    const warnings: string[] = []

    const dfs = (nodeName: string, currentWorkflow: any[]) => {
      const node = nodeMap.get(nodeName)
      if (!node || node.visited) return

      node.visited = true
      currentWorkflow.push(node)

      // Find all connected nodes
      connections.forEach((conn: string) => {
        const [source, target] = conn.split('-')
        if (source === nodeName && nodeMap.has(target)) {
          dfs(target, currentWorkflow)
        }
        if (target === nodeName && nodeMap.has(source)) {
          dfs(source, currentWorkflow)
        }
      })
    }

    // Find all disjoint workflows
    nodeMap.forEach((node, nodeName) => {
      if (!node.visited) {
        const workflow: any[] = []
        dfs(nodeName, workflow)
        if (workflow.length > 0) {
          workflows.push(workflow)
        }
      }
    })

    // Validate each workflow has a trigger at the start
    workflows.forEach((workflow, index) => {
      // Find root nodes (nodes with no incoming connections within this workflow)
      const workflowNodeNames = new Set(workflow.map(n => n.name))
      const rootNodes = workflow.filter(node => {
        // Check if this node has any incoming connections from within this workflow
        return !connections.some((conn: string) => {
          const [source, target] = conn.split('-')
          return target === node.name && workflowNodeNames.has(source)
        })
      })

      // Check if any root node has a trigger category tool
      const hasTriggerStart = rootNodes.some(node => {
        if (!node.tool) return false
        const category = node.tool.category || getCategoryFromType(node.tool.type)
        return category === "trigger"
      })

      if (!hasTriggerStart) {
        const workflowNodesList = workflow.map(n => n.name).join(', ')
        warnings.push(`Workflow ${index + 1} (nodes: ${workflowNodesList}) does not have a trigger category node at the start`)
      }
    })

    return {
      isValid: warnings.length === 0,
      workflowCount: workflows.length,
      workflows: workflows.map((workflow, index) => ({
        id: index + 1,
        nodeCount: workflow.length,
        nodes: workflow.map(n => n.name),
        hasValidStart: !warnings.some(w => w.includes(`Workflow ${index + 1}`))
      })),
      warnings
    }
}

// Validate workflow template API
export const ValidateTemplate = async (c: Context) => {
  try {
    const requestData = await c.req.json()
    const { nodes, connections } = requestData

    const validation = await validateTemplateLogic(nodes, connections)

    return c.json({
      success: true,
      data: validation,
      message: validation.warnings.length === 0 
        ? `Template validation passed. Found ${validation.workflowCount} valid workflow(s).`
        : `Template validation found ${validation.warnings.length} warning(s).`
    })
  } catch (error) {
    Logger.error(error, "Failed to validate workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Activate workflow template - set state to active and schedule triggers
export const ActivateWorkflowTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    const { templateId } = requestData

    if (!templateId) {
      throw new HTTPException(400, { message: "templateId is required" })
    }

    // Validate template exists and user has access
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(and(
        eq(workflowTemplate.id, templateId),
        eq(workflowTemplate.workspaceId, user.workspaceId),
        or(
          eq(workflowTemplate.isPublic, true),
          eq(workflowTemplate.userId, user.id),
        )
      ))

    if (!template) {
      throw new HTTPException(404, {
        message: "Workflow template not found",
      })
    }

    // Update template state to active
    
    // Activate template triggers using execution engine
    const activateResult = await handleActivateTemplate(template as SelectWorkflowTemplate)

    
    await db
      .update(workflowTemplate)
      .set({
        state: "active",
        updatedAt: new Date(),
      })
      .where(eq(workflowTemplate.id, templateId))
      .returning()

    Logger.info(`✅ Activated workflow template ${templateId}`)

    return c.json({
      success: true,
      data: {
        template: template,
        activateResult,
      },
      message: "Workflow template activated successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to activate workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}