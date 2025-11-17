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
import { grantUserWorkflowPermission } from "@/db/userWorkflowPermissions"
import { insertUserWorkflowPermissionSchema } from "../db/schema"
import { getWorkflowTemplateByIdWithPermissionCheck } from "@/db/workflow"

// Get available tool types with their schemas
export const GetAvailableToolTypesApi = async (c: Context) => {
  try {
    const supportedToolTypes = getSupportedToolTypes()
    
    const toolsData = supportedToolTypes.map(toolType => {      
      return {
        type: toolType,
        category: getToolCategory(toolType),
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
        category: getToolCategory(toolType as ToolType),
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
    type: z.any(),
    default: z.any().optional(),
    limit: z.number().optional(),
    values: z.array(z.any()).optional(),
    optional: z.boolean().optional()
  })).optional()
}).loose()


// Schema for creating workflow template
export const createTemplateSchema = z.object({
  name: z.string().min(1),
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
    metadata:z.any().optional(),
    toolCategory: z.string(),
    toolType: z.string(),
    toolConfig: z.any().optional(),
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
    const { name,description, isPublic, version } = validatedData        
      // 1. Create the main workflow template
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
        state: TemplateState.INACTIVE,
      })
      .returning()

      const permissionContext = insertUserWorkflowPermissionSchema.parse({
        userId: user.id,
        workflowId: template.id,
        role: "owner",
      })
      await grantUserWorkflowPermission(db, permissionContext)
      return c.json({
        success: true,
        data: {
          template: {
            ...template,
            createdAt: template.createdAt.toISOString(),
            updatedAt: template.updatedAt.toISOString(),
          }
        },
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
    const isTemplate = await getWorkflowTemplateByIdWithPermissionCheck(db, id, user.id, user.workspaceId)
    if (!isTemplate) {
      throw new HTTPException(404, { message: "Workflow template not found or access denied" })
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
    const template = await getWorkflowTemplateByIdWithPermissionCheck(db, templateId, user.id, user.workspaceId)
    if (!template) {
      throw new HTTPException(404, { message: "Workflow template not found or access denied" })
    }

    // Get the steps for this template
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(and(eq(workflowStepTemplate.workflowTemplateId, templateId), eq(workflowStepTemplate.deprecated, false)))

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
        toolId: null, 
        metadata: step.metadata,
        toolCategory: step.toolCategory,
        toolType: step.toolType,
        toolConfig: step.toolConfig,
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
    const isTemplate = await getWorkflowTemplateByIdWithPermissionCheck(db, id, user.id, user.workspaceId)
    if (!isTemplate) {
      throw new HTTPException(404, { message: "Workflow template not found or access denied" })
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

    // Check if state change failed
    if (stateChangeResult.success === false) {
      Logger.error(`State change failed for template ${templateId}: ${stateChangeResult.error}`)
      return c.json({
        success: false,
        message: `Failed to ${state} workflow template: ${templateId}`,
      }, 400)
    }

    // Update template state only if state change was successful
    const [updatedTemplate] = await db
      .update(workflowTemplate)
      .set({
        state: state,
        updatedAt: new Date(),
      })
      .where(eq(workflowTemplate.id, templateId))
      .returning()

    Logger.info(`✅ ${state} workflow template ${templateId}`)

    return c.json({
      success: true,
      data: {
        template: updatedTemplate,
        stateChangeResult
      },
      message: `Workflow template ${state} successfully`,
    })
  } catch (error) {
    Logger.error(error, `Failed to change state to ${state} for wfId: ${c.req.param("templateId")}`)
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}