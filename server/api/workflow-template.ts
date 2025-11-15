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
import { handleTemplateStateChange } from "@/execution-engine/triggers"


const loggerWithChild = getLoggerWithChild(Subsystem.WorkflowApi)
const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.WorkflowApi)

// New Workflow Template API Routes
export const workflowTemplateRouter = new Hono()

import { getSupportedToolTypes, getTool, getToolCategory } from "@/workflow-tools/registry"
import { TemplateState, ToolType, WorkflowStatus } from "@/types/workflowTypes"

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
        defaultConfig: schemas.defaultConfig,
      },
    })
  } catch (error) {
    Logger.error(error, `Failed to get schema for tool type: ${c.req.param("toolType")}`)
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

export const workflowToolConfigSchema = z.object({
  inputCount: z.number(),
  outputCount: z.number(),
  options: z.record(z.string(), z.object({
    type: z.string(),
    default: z.any().optional(),
    limit: z.number().optional(),
    values: z.array(z.any()).optional(),
    optional: z.boolean().optional()
  })).optional()
}).loose()

//schema for nodes
const NodeSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  tool: z.object({
    type: z.string(),
    category: z.string(),
    value: z.any().optional(),
    config: workflowToolConfigSchema
  })
})

// Schema for creating workflow template
export const createTemplateSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(NodeSchema),
  connections: z.array(z.array(z.string())),
  description: z.string().optional(),
  isPublic: z.boolean().default(false),
  version: z.string().default("1.0.0"),
})

// Schema for updating workflow template
export const updateTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isPublic: z.boolean().optional(),
  version: z.string().optional()
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
    metadata:z.object().optional()
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
export type workflowToolType = z.infer<typeof workflowToolConfigSchema>

// Create workflow template API
export const CreateTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()

    const validatedData = createTemplateSchema.parse(requestData)
    const { name, nodes, connections, description, isPublic, version } = validatedData

    // Validate template before creating
    const validation = await validateTemplateLogic(nodes, connections)
    if (!validation.isValid) {
      return c.json({
        success: false,
        errors: validation.warnings,
        message: `Template validation failed with ${validation.warnings.length} error(s)`,
      }, 400)
    }

    // Execute all database operations in a single transaction
    const { template, stepIdMap, toolIdMap } = await db.transaction(async (tx) => {
      // 1. Create the main workflow template
      const [template] = await tx
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

      // 2. Create tools for each node (one tool per step)
      const toolIdMap = new Map<string, string>()
      
      for (const node of nodes) {
        if (node.tool) {
          const [createdTool] = await tx
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

          toolIdMap.set(node.uuid, createdTool.id)
        }
      }

      // 3. Create step templates
      const stepIdMap = new Map<string, string>()
      
      for (const node of nodes) {
        const [createdStep] = await tx
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
            toolIds: toolIdMap.has(node.uuid) ? [toolIdMap.get(node.uuid)!] : [],
          })
          .returning()
        
        stepIdMap.set(node.uuid, createdStep.id)
      }

      // 4. Calculate step relationships from connections
      const stepUpdates = new Map<string, {
        nextStepIds: string[],
        prevStepIds: string[],
        outRoutes: Record<string, string[]>,
        inRoutes: Record<string, string[]>
      }>()

      // Initialize updates for all steps
      for (const [nodeUuid, stepId] of stepIdMap) {
        stepUpdates.set(stepId, {
          nextStepIds: [],
          prevStepIds: [],
          outRoutes: {},
          inRoutes: {}
        })
      }

      // Build relationships from connections
      for (const connection of connections) {
        const [[sourceId, outRoute], [targetId, inRoute]] = extractUUIDFromArray(connection)
        const sourceStepId = stepIdMap.get(sourceId)
        const targetStepId = stepIdMap.get(targetId)
        
        if (sourceStepId && targetStepId) {
          // Update source step
          const sourceUpdate = stepUpdates.get(sourceStepId)!
          sourceUpdate.nextStepIds.push(targetStepId)
          
          // Initialize outRoute array if it doesn't exist
          if (!sourceUpdate.outRoutes[`out${outRoute}`]) {
            sourceUpdate.outRoutes[`out${outRoute}`] = []
          }
          sourceUpdate.outRoutes[`out${outRoute}`].push(targetStepId)

          // Update target step  
          const targetUpdate = stepUpdates.get(targetStepId)!
          targetUpdate.prevStepIds.push(sourceStepId)
          
          // Initialize inRoute array if it doesn't exist
          if (!targetUpdate.inRoutes[`in${inRoute}`]) {
            targetUpdate.inRoutes[`in${inRoute}`] = []
          }
          targetUpdate.inRoutes[`in${inRoute}`].push(sourceStepId)
        }
      }

      // Apply all updates in batch
      for (const [stepId, update] of stepUpdates) {
        const metadata = {
          ...(Object.keys(update.outRoutes).length > 0 && { outRoutes: update.outRoutes }),
          ...(Object.keys(update.inRoutes).length > 0 && { inRoutes: update.inRoutes })
        }

        await tx
          .update(workflowStepTemplate)
          .set({
            nextStepIds: update.nextStepIds,
            prevStepIds: update.prevStepIds,
            ...(Object.keys(metadata).length > 0 && { metadata })
          })
          .where(eq(workflowStepTemplate.id, stepId))
      }

      return { template, stepIdMap, toolIdMap }
    })

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
      connections: connections.map((conn: string[]) => {
        // const [sourceName, targetName] = conn.split('-')
        const [[sourceId,], [targetId,]] = extractUUIDFromArray(conn)
        const sourceStep = createdSteps.find(s => s.id === stepIdMap.get(sourceId))
        const targetStep = createdSteps.find(s => s.id === stepIdMap.get(targetId))
        return {
          source: sourceStep?.name || '',
          target: targetStep?.name || '',
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
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    
    const validatedData = updateTemplateSchema.parse(requestData)
    const { id, name, description, isPublic, version } = validatedData

    // Validate template exists and user has access
    const [existingTemplate] = await db
      .select()
      .from(workflowTemplate)
      .where(and(
        eq(workflowTemplate.id, id),
        eq(workflowTemplate.workspaceId, user.workspaceId),
        or(
          eq(workflowTemplate.isPublic, true),
          eq(workflowTemplate.userId, user.id),
        )
      ))

    if (!existingTemplate) {
      throw new HTTPException(404, {
        message: "Workflow template not found or access denied",
      })
    }

    if(existingTemplate.deprecated === true){
      throw new HTTPException(400, {
        message: "Workflow template is deprecated and cannot be updated",
      })
    }

    // Build update object with only provided fields
    const updateData: Partial<typeof workflowTemplate.$inferInsert> = {
      updatedAt: new Date(),
    }

    if (name !== undefined) updateData.name = name
    if (description !== undefined) updateData.description = description
    if (isPublic !== undefined) updateData.isPublic = isPublic
    if (version !== undefined) updateData.version = version

    // Update the template
    const [updatedTemplate] = await db
      .update(workflowTemplate)
      .set(updateData)
      .where(eq(workflowTemplate.id, id))
      .returning()

    Logger.info(`✅ Updated workflow template ${id}`)

    return c.json({
      success: true,
      data: {
        template: {
          ...updatedTemplate,
          createdAt: updatedTemplate.createdAt.toISOString(),
          updatedAt: updatedTemplate.updatedAt.toISOString(),
        }
      },
      message: "Workflow template updated successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to update workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
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
      return c.json({
        success: false,
        error: "TEMPLATE_NOT_FOUND",
        message: "Workflow template not found"
      }, 404)
    }

    if (template.deprecated === true) {
      return c.json({
        success: false,
        error: "TEMPLATE_DEPRECATED", 
        message: "Workflow template has been deprecated and is no longer accessible"
      }, 404)
    }

    // Get the steps for this template
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(and(eq(workflowStepTemplate.workflowTemplateId, templateId), eq(workflowStepTemplate.deprecated, false)))

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
        matadata: step.metadata || {}
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
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const id = c.req.param("templateId")

    // Validate template exists and user has access
    const [existingTemplate] = await db
      .select()
      .from(workflowTemplate)
      .where(and(
        eq(workflowTemplate.id, id),
        eq(workflowTemplate.workspaceId, user.workspaceId),
        or(
          eq(workflowTemplate.isPublic, true),
          eq(workflowTemplate.userId, user.id),
        )
      ))

    if (!existingTemplate) {
      throw new HTTPException(404, {
        message: "Workflow template not found or access denied",
      })
    }

    // Check if template is already deprecated
    if (existingTemplate.deprecated === true) {
      throw new HTTPException(400, {
        message: "Workflow template is already deprecated",
      })
    }

    // Update template status to deprecated instead of hard delete
    const [updatedTemplate] = await db
      .update(workflowTemplate)
      .set({
        deprecated: true,
        updatedAt: new Date(),
      })
      .where(eq(workflowTemplate.id, id))
      .returning()

    Logger.info(`✅ Marked workflow template ${id} as deprecated`)

    return c.json({
      success: true,
      data: {
        template: {
          ...updatedTemplate,
          createdAt: updatedTemplate.createdAt.toISOString(),
          updatedAt: updatedTemplate.updatedAt.toISOString(),
        }
      },
      message: "Workflow template marked as deprecated successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to delete workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

const extractUUIDFromArray = (routeIds: string[]):string[][] => {
  const [source, outRoute = "1"] = routeIds[0].split('_')
  const [dest, inRoute = "1"] = routeIds[1].split('_')
  return [[source, outRoute],[dest, inRoute]]
}


// Helper function for template validation logic
export const validateTemplateLogic = async (nodes: any[], connections: string[][]) => {

    // Build a graph to find disjoint workflows
    const nodeMap = new Map()
    const incomingConnections = new Set()
    const outgoingConnections = new Set()

    // Initialize node map
    nodes.forEach((node: any) => {
      nodeMap.set(node.uuid, {
        ...node,
        visited: false,
        hasIncoming: false,
        hasOutgoing: false
      })
    })

    // Process connections to identify incoming/outgoing relationships
    connections.forEach((conn: string[]) => {
      const [[source,], [target,]] = extractUUIDFromArray(conn) 
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
      connections.forEach((conn: string[]) => {
        const [[source,], [target,]] = extractUUIDFromArray(conn)
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
        return !connections.some((conn: string[]) => {
          const [[source,], [target,]] = extractUUIDFromArray(conn)
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

export const HandleStateChangeTemplateApi = async (c: Context, state: TemplateState) => {
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

    if (template.state === state) {
      throw new HTTPException(400, {
        message: `Workflow template is already ${state}`,
      })
    }

    const stateChangeResult = await handleTemplateStateChange(template as SelectWorkflowTemplate,state)

    // Update template state to inactive
    const [updatedTemplate] = await db
      .update(workflowTemplate)
      .set({
        state: state,
        updatedAt: new Date(),
      })
      .where(eq(workflowTemplate.id, templateId))
      .returning()

    Logger.info(`✅ Deactivated workflow template ${templateId}`)

    return c.json({
      success: true,
      data: {
        template: updatedTemplate,
        stateChangeResult
      },
      message: "Workflow template deactivated successfully",
    })
  } catch (error) {
    Logger.error(error, `Failed to change state to ${state} for wfId: ${c.req.param("templateId")}`)
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}