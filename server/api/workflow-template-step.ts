import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { HTTPException } from "hono/http-exception"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { getUserFromJWT } from "@/db/user"
import { db } from "@/db/client"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowTool,
} from "@/db/schema/workflows"
import { eq, and } from "drizzle-orm"
// import { getCategoryFromType } from "./workflow-template"
import { workflowToolConfigSchema } from "./workflow-template"
import {getToolCategory, getToolDefaultConfig} from "@/workflow-tools/registry"
import { ToolType } from "@/types/workflowTypes"
import { checkAccessWithTemplateStepId, getWorkflowTemplateByIdWithPermissionCheck } from "@/db/workflow"

const Logger = getLogger(Subsystem.WorkflowApi)
const { JwtPayloadKey } = config

// Schema for adding a step to existing template
export const addTemplateStepSchema = z.object({
  template_id: z.string().min(1),
  connection: z.object({
    source: z.object({
        step_id: z.string(),
        route: z.number().min(1)
    }),
    target_route: z.number().min(1),
  }).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum([ "manual", "automated" ]).default("automated"),
  position: z.object({
    x: z.number(),
    y: z.number()
  }).optional(),
  tool: z.object({
    type: z.enum(ToolType),
    value: z.record(z.string(), z.any()).default({}),
    config: workflowToolConfigSchema
  })
})

export const updateTemplateStepSchema = z.object({
  step_id: z.string().min(1),
  connection: z.object({
    source_route: z.number().min(1),
    target: z.object({
      step_id: z.string(),
      route: z.number().min(1)
    })
  }).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(["manual", "automated"]).optional(),
  position: z.object({
    x: z.number(),
    y: z.number()
  }).optional(),
  tool: z.object({
    type: z.enum(ToolType).optional(),
    value: z.record(z.string(), z.any()).default({}).optional(),
    config: workflowToolConfigSchema
  }).optional()
})

export const deleteTemplateStepSchema = z.object({
  step_id: z.string()
})

export const deleteLinkSchema = z.object({
  template_id: z.string().min(1),
  source: z.object({
      step_id: z.string(),
      route: z.number().min(1)
  }),
  target: z.object({
    step_id: z.string(),
    route: z.number().min(1)
  })
})

// Add workflow template step API
export const AddTemplateStepApiHandler = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    
    // Validate request data
    const validatedData = addTemplateStepSchema.parse(requestData)
    const { template_id, connection, name, description, type, position, tool } = validatedData
    const isTemplate = await getWorkflowTemplateByIdWithPermissionCheck(db, template_id, user.id, user.workspaceId)
    if (!isTemplate) {
      throw new HTTPException(404, { message: "Workflow template not found or access denied" })
    }
    // Validate connection if provided
    if (connection) {
      if (tool.config.inputCount === 0) {
        throw new Error("Cannot create connection to this step: target step doesn't accept any inputs (inputCount is 0)")
      }
      
      if (connection.target_route > tool.config.inputCount) {
        throw new Error(`Cannot connect to input route ${connection.target_route}: target step only has ${tool.config.inputCount} input(s)`)
      }
    }

    //validate tool config
    const toolDefaultConfig = getToolDefaultConfig(tool.type as ToolType)
    if(tool.config.inputCount<0 || tool.config.outputCount<0){
      throw new Error("Invalid tool config: inputCount and outputCount must be non-negative")
    }
    for (const key in toolDefaultConfig.options) {
      const option = toolDefaultConfig.options[key]
      if (!option.optional && !tool.config[key]) {
        throw new Error(`Missing required tool config option: ${key}`)
      }
    }

    // Execute all database operations in a single transaction
    const result = await db.transaction(async (tx) => {
      // 1. Verify template exists and user has access
      const [template] = await tx
        .select()
        .from(workflowTemplate)
        .where(
          and(
            eq(workflowTemplate.id, template_id),
            eq(workflowTemplate.workspaceId, user.workspaceId),
            eq(workflowTemplate.userId, user.id)
          )
        )

      if (!template) {
        throw new Error("Template not found or access denied")
      }
      if(template.deprecated === true){
        throw new Error("Template is deprecated")
      }

      const modifiedToolConfig:Record<string,any> = { ...toolDefaultConfig}
      
      // Override default config with user-provided values
      if (tool.config) {
        // Override top-level config properties
        if (tool.config.inputCount !== undefined) {
          modifiedToolConfig.inputCount = tool.config.inputCount
        }
        if (tool.config.outputCount !== undefined) {
          modifiedToolConfig.outputCount = tool.config.outputCount
        }
        delete modifiedToolConfig.options
        
        // Handle other top-level properties that might exist
        Object.keys(tool.config).forEach(key => {
          if (!['inputCount', 'outputCount'].includes(key)) {
            (modifiedToolConfig as any)[key] = tool.config[key]
          }
        })
      }

      // 3. Create the new step template
      const stepMetadata: Record<string, any> = {}
      if (position) {
        stepMetadata.position = position
      }

      const [createdStep] = await tx
        .insert(workflowStepTemplate)
        .values({
          workflowTemplateId: template_id,
          name,
          description: description || "",
          type: type === "manual" ? "manual" : "automated",
          timeEstimate: 180,
          metadata: stepMetadata,
          prevStepIds: [],
          nextStepIds: [],
          toolIds: [],
          toolCategory: getToolCategory(tool.type as ToolType),
          toolType: tool.type,
          toolConfig: modifiedToolConfig || {},
        })
        .returning()

      // 4. Update connections if source and target_route are provided
      if (connection) {
        // Get source step to update its connections
        const { source, target_route } = connection
        const [sourceStep] = await tx
          .select()
          .from(workflowStepTemplate)
          .where(
            and(
              eq(workflowStepTemplate.id, source.step_id),
              eq(workflowStepTemplate.workflowTemplateId, template_id)
            )
          )

        if (!sourceStep) {
          throw new Error("Source step not found")
        }

        // Update source step to include new step as next
        const updatedNextStepIds = [...(sourceStep.nextStepIds || []), createdStep.id]
        const existingOutRoutes = (sourceStep.metadata as any)?.outRoutes || {}
        const routeKey = `out${source.route}`
        const updatedOutRoutes = {
          ...existingOutRoutes,
          [routeKey]: [...(existingOutRoutes[routeKey] || []), createdStep.id]
        }

        await tx
          .update(workflowStepTemplate)
          .set({
            nextStepIds: updatedNextStepIds,
            metadata: {
              ...sourceStep.metadata as any,
              outRoutes: updatedOutRoutes
            }
          })
          .where(eq(workflowStepTemplate.id, source.step_id))

        // Update new step to include source as previous
        const existingInRoutes = (createdStep.metadata as any)?.inRoutes || {}
        const targetRouteKey = `in${target_route}`
        const updatedInRoutes = {
          ...existingInRoutes,
          [targetRouteKey]: [...(existingInRoutes[targetRouteKey] || []), source.step_id]
        }

        await tx
          .update(workflowStepTemplate)
          .set({
            prevStepIds: [source.step_id],
            metadata: {
              ...createdStep.metadata as any,
              inRoutes: updatedInRoutes
            }
          })
          .where(eq(workflowStepTemplate.id, createdStep.id))
      }

      return {
        template,
        createdStep
      }
    })

    return c.json({
      success: true,
      data: {
        step: {
          id: result.createdStep.id,
          name: result.createdStep.name,
          description: result.createdStep.description,
          type: result.createdStep.type,
          prevStepIds: result.createdStep.prevStepIds,
          nextStepIds: result.createdStep.nextStepIds,
          toolCategory: result.createdStep.toolCategory,
          toolType: result.createdStep.toolType,
          toolConfig: result.createdStep.toolConfig,
        }
      },
      message: "Template step added successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to add template step")
    const statusCode = (error as any).statusCode || 500
    return c.json({
      success: false,
      message: getErrorMessage(error),
    }, statusCode)
  }
}


export const UpdateTemplateStepApiHandler = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    
    // Validate request data
    const validatedData = updateTemplateStepSchema.parse(requestData)
    const { step_id, connection, name, description, type, position, tool } = validatedData

    const hasAccess = checkAccessWithTemplateStepId(db, step_id, user.id, user.workspaceId)
    if (!hasAccess) {
      return c.json({
        message: "Workflow template not found or access denied",
      }, 404)
    }

    // Execute all database operations in a single transaction
    const result = await db.transaction(async (tx) => {
      // 1. Get the existing step and verify access
      const [existingStep] = await tx
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.id, step_id))

      if (!existingStep) {
        throw new Error("Step not found")
      }

      // 2. Verify template access
      const [template] = await tx
        .select()
        .from(workflowTemplate)
        .where(
          and(
            eq(workflowTemplate.id, existingStep.workflowTemplateId),
            eq(workflowTemplate.workspaceId, user.workspaceId),
            eq(workflowTemplate.userId, user.id)
          )
        )

      if (!template) {
        throw new Error("Template not found or access denied")
      }
    
      // Validate tool config against existing connections if tool config is being updated
      if (tool?.config) {
        const metadata = existingStep.metadata as any || {}
        
        // Check input routes
        if (metadata.inRoutes && typeof metadata.inRoutes === 'object') {
          const inRouteKeys = Object.keys(metadata.inRoutes)
          const maxInRouteNum = Math.max(0, ...inRouteKeys.map(key => {
            const match = key.match(/in(\d+)/)
            return match ? parseInt(match[1]) : 0
          }))
          
          if (tool.config.inputCount < maxInRouteNum) {
            throw new Error(`Cannot reduce input count to ${tool.config.inputCount}. Step has connections to input route ${maxInRouteNum}. Remove connections first.`)
          }
        }
        
        // Check output routes  
        if (metadata.outRoutes && typeof metadata.outRoutes === 'object') {
          const outRouteKeys = Object.keys(metadata.outRoutes)
          const maxOutRouteNum = Math.max(0, ...outRouteKeys.map(key => {
            const match = key.match(/out(\d+)/)
            return match ? parseInt(match[1]) : 0
          }))
          
          if (tool.config.outputCount < maxOutRouteNum) {
            throw new Error(`Cannot reduce output count to ${tool.config.outputCount}. Step has connections from output route ${maxOutRouteNum}. Remove connections first.`)
          }
        }
      }

      // 3. Update tool if provided
      const updateToolData: any = {} // to be updated
      if (tool) {
        updateToolData.toolType = (tool.type !== undefined) ? tool.type : existingStep.toolType
        updateToolData.toolConfig = (tool.config !== undefined) ? tool.config : existingStep.toolConfig
      }

      // 4. Prepare step metadata updates
      const existingMetadata = (existingStep.metadata as any) || {}
      const updatedMetadata = { ...existingMetadata }

      // Update position if provided
      if (position) {
        updatedMetadata.position = position
      }

      // 5. Handle connection updates if provided
      if (connection) {
        const { source_route, target } = connection

        // Validate that source and target are different steps
        if (target.step_id === step_id) {
          throw new Error("Source and target step cannot be the same")
        }

        // Get target step
        const [targetStep] = await tx
          .select()
          .from(workflowStepTemplate)
          .where(
            and(
              eq(workflowStepTemplate.id, target.step_id),
              eq(workflowStepTemplate.workflowTemplateId, existingStep.workflowTemplateId)
            )
          )

        if (!targetStep) {
          throw new Error("Target step not found")
        }

        // Update current step (source) outRoutes and nextStepIds
        const sourceRouteKey = `out${source_route}`

        // Add target step to current step's outRoutes array
        if (!updatedMetadata.outRoutes) {
          updatedMetadata.outRoutes = {}
        }
        if (!updatedMetadata.outRoutes[sourceRouteKey]) {
          updatedMetadata.outRoutes[sourceRouteKey] = []
        }
        if (!updatedMetadata.outRoutes[sourceRouteKey].includes(target.step_id)) {
          updatedMetadata.outRoutes[sourceRouteKey].push(target.step_id)
        }

        // Update current step nextStepIds
        const updatedNextStepIds = [...(existingStep.nextStepIds || [])]
        if (!updatedNextStepIds.includes(target.step_id)) {
          updatedNextStepIds.push(target.step_id)
        }
        existingStep.nextStepIds = updatedNextStepIds

        // Update target step's inRoutes and prevStepIds
        const targetMetadata = (targetStep.metadata as any) || {}
        const targetInRoutes = targetMetadata.inRoutes || {}
        const targetRouteKey = `in${target.route}`
        
        if (!targetInRoutes[targetRouteKey]) {
          targetInRoutes[targetRouteKey] = []
        }
        if (!targetInRoutes[targetRouteKey].includes(step_id)) {
          targetInRoutes[targetRouteKey].push(step_id)
        }

        // Update target step prevStepIds
        const targetUpdatedPrevStepIds = [...(targetStep.prevStepIds || [])]
        if (!targetUpdatedPrevStepIds.includes(step_id)) {
          targetUpdatedPrevStepIds.push(step_id)
        }
        await tx
          .update(workflowStepTemplate)
          .set({
            prevStepIds: targetUpdatedPrevStepIds,
            metadata: {
              ...targetMetadata,
              inRoutes: targetInRoutes
            }
          })
          .where(eq(workflowStepTemplate.id, target.step_id))
      }

      // 6. Update the step template
      const stepUpdateData: any = { metadata: updatedMetadata }
      if (name) stepUpdateData.name = name
      if (description !== undefined) stepUpdateData.description = description
      if (type) stepUpdateData.type = type
      if (connection) {
        stepUpdateData.nextStepIds = existingStep.nextStepIds
      }
      if (Object.keys(updateToolData).length > 0){
        stepUpdateData.toolType = updateToolData.toolType
        stepUpdateData.toolConfig = updateToolData.toolConfig
      }


      const [updatedStep] = await tx
        .update(workflowStepTemplate)
        .set(stepUpdateData)
        .where(eq(workflowStepTemplate.id, step_id))
        .returning()

      return {
        updatedStep
      }
    })

    return c.json({
      success: true,
      data: {
        step: {
          id: result.updatedStep.id,
          name: result.updatedStep.name,
          description: result.updatedStep.description,
          type: result.updatedStep.type,
          prevStepIds: result.updatedStep.prevStepIds,
          nextStepIds: result.updatedStep.nextStepIds,
          metadata: result.updatedStep.metadata,
        },
        tool:{
          category: result.updatedStep.toolCategory,
          type: result.updatedStep.toolType,
          config: result.updatedStep.toolConfig,
        }
      },
      message: "Template step updated successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to update template step")
    const statusCode = (error as any).statusCode || 500
    return c.json({
      success: false,
      message: getErrorMessage(error),
    }, statusCode)
  }
}

export const DeleteTemplateStepApiHandler = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    
    // Validate request data
    const validatedData = deleteTemplateStepSchema.parse(requestData)
    const { step_id } = validatedData

    const hasAccess = checkAccessWithTemplateStepId(db, step_id, user.id, user.workspaceId)
    if (!hasAccess) {
      return c.json({
        message: "Workflow template not found or access denied",
      }, 404)
    }

    // Execute all database operations in a single transaction
    const result = await db.transaction(async (tx) => {
      // 1. Get the current step to be deleted
      const [currentStep] = await tx
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.id, step_id))

      if (!currentStep) {
        throw new Error("Step not found")
      }

      // 2. Verify user has access to the template
      const [template] = await tx
        .select()
        .from(workflowTemplate)
        .where(
          and(
            eq(workflowTemplate.id, currentStep.workflowTemplateId),
            eq(workflowTemplate.workspaceId, user.workspaceId),
            eq(workflowTemplate.userId, user.id)
          )
        )

      if (!template) {
        throw new Error("Template not found or access denied")
      }

      const nextStepIds = currentStep.nextStepIds || []
      const prevStepIds = currentStep.prevStepIds || []
      const currentMetadata = (currentStep.metadata as any) || {}

      // 3. Update next steps - remove current step from their prevStepIds and inRoutes
      for (const nextStepId of nextStepIds) {
        const [nextStep] = await tx
          .select()
          .from(workflowStepTemplate)
          .where(eq(workflowStepTemplate.id, nextStepId))

        if (nextStep) {
          const nextMetadata = (nextStep.metadata as any) || {}
          const nextInRoutes = nextMetadata.inRoutes || {}
          
          // Remove current step from next step's prevStepIds
          const updatedPrevStepIds = (nextStep.prevStepIds || []).filter(id => id !== step_id)
          
          // Remove routes that point to the current step from inRoutes
          const updatedInRoutes = { ...nextInRoutes }
          Object.keys(updatedInRoutes).forEach(routeKey => {
            if (Array.isArray(updatedInRoutes[routeKey])) {
              updatedInRoutes[routeKey] = updatedInRoutes[routeKey].filter((id: string) => id !== step_id)
              // Remove empty route arrays
              if (updatedInRoutes[routeKey].length === 0) {
                delete updatedInRoutes[routeKey]
              }
            }
          })

          await tx
            .update(workflowStepTemplate)
            .set({
              prevStepIds: updatedPrevStepIds,
              metadata: {
                ...nextMetadata,
                inRoutes: updatedInRoutes
              },
              updatedAt: new Date()
            })
            .where(eq(workflowStepTemplate.id, nextStepId))
        }
      }

      // 4. Update previous steps - remove current step from their nextStepIds and outRoutes
      for (const prevStepId of prevStepIds) {
        const [prevStep] = await tx
          .select()
          .from(workflowStepTemplate)
          .where(eq(workflowStepTemplate.id, prevStepId))

        if (prevStep) {
          const prevMetadata = (prevStep.metadata as any) || {}
          const prevOutRoutes = prevMetadata.outRoutes || {}
          
          // Remove current step from previous step's nextStepIds
          const updatedNextStepIds = (prevStep.nextStepIds || []).filter(id => id !== step_id)
          
          // Remove routes that point to the current step from outRoutes
          const updatedOutRoutes = { ...prevOutRoutes }
          Object.keys(updatedOutRoutes).forEach(routeKey => {
            if (Array.isArray(updatedOutRoutes[routeKey])) {
              updatedOutRoutes[routeKey] = updatedOutRoutes[routeKey].filter((id: string) => id !== step_id)
              // Remove empty route arrays
              if (updatedOutRoutes[routeKey].length === 0) {
                delete updatedOutRoutes[routeKey]
              }
            }
          })

          await tx
            .update(workflowStepTemplate)
            .set({
              nextStepIds: updatedNextStepIds,
              metadata: {
                ...prevMetadata,
                outRoutes: updatedOutRoutes
              },
              updatedAt: new Date()
            })
            .where(eq(workflowStepTemplate.id, prevStepId))
        }
      }

      // 5. Mark the current step as deprecated instead of hard delete
      await tx
        .update(workflowStepTemplate)
        .set({
          deprecated: true,
          updatedAt: new Date()
        })
        .where(eq(workflowStepTemplate.id, step_id))

      return {
        deletedStepId: step_id,
        updatedNextSteps: nextStepIds,
        updatedPrevSteps: prevStepIds
      }
    })

    Logger.info(`✅ Deleted step ${step_id} and updated relationships`)

    return c.json({
      success: true,
      data: result,
      message: "Template step deleted successfully and relationships updated"
    })
    
  } catch (error) {
    Logger.error(error, "Failed to delete template step")
    const statusCode = (error as any).statusCode || 500
    return c.json({
      success: false,
      message: getErrorMessage(error),
    }, statusCode)
  }
}


export const deleteLink = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()
    
    // Validate request data
    const validatedData = deleteLinkSchema.parse(requestData)
    const { template_id, source, target } = validatedData

    const isTemplate = await getWorkflowTemplateByIdWithPermissionCheck(db, template_id, user.id, user.workspaceId)
    if (!isTemplate) {
      throw new HTTPException(404, { message: "Workflow template not found or access denied" })
    }

    // Execute all database operations in a single transaction
    const result = await db.transaction(async (tx) => {
      // 1. Verify template exists and user has access
      const [template] = await tx
        .select()
        .from(workflowTemplate)
        .where(
          and(
            eq(workflowTemplate.id, template_id),
            eq(workflowTemplate.workspaceId, user.workspaceId),
            eq(workflowTemplate.userId, user.id)
          )
        )

      if (!template) {
        throw new Error("Template not found or access denied")
      }

      // 2. Get source step
      const [sourceStep] = await tx
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.id, source.step_id))

      if (!sourceStep) {
        throw new Error("Source step not found")
      }

      // 3. Get target step
      const [targetStep] = await tx
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.id, target.step_id))

      if (!targetStep) {
        throw new Error("Target step not found")
      }

      // 4. Update source step - remove target from nextStepIds and outRoutes
      const sourceMetadata = (sourceStep.metadata as any) || {}
      const sourceOutRoutes = sourceMetadata.outRoutes || {}
      
      // Remove target step from source's nextStepIds
      const updatedSourceNextStepIds = (sourceStep.nextStepIds || []).filter(id => id !== target.step_id)
      
      // Remove target step from specific outRoute
      const updatedSourceOutRoutes = { ...sourceOutRoutes }
      const sourceRouteKey = `out${source.route}`
      if (updatedSourceOutRoutes[sourceRouteKey]) {
        updatedSourceOutRoutes[sourceRouteKey] = updatedSourceOutRoutes[sourceRouteKey].filter((id: string) => id !== target.step_id)
        // Remove empty route arrays
        if (updatedSourceOutRoutes[sourceRouteKey].length === 0) {
          delete updatedSourceOutRoutes[sourceRouteKey]
        }
      }

      await tx
        .update(workflowStepTemplate)
        .set({
          nextStepIds: updatedSourceNextStepIds,
          metadata: {
            ...sourceMetadata,
            outRoutes: updatedSourceOutRoutes
          },
          updatedAt: new Date()
        })
        .where(eq(workflowStepTemplate.id, source.step_id))

      // 5. Update target step - remove source from prevStepIds and inRoutes
      const targetMetadata = (targetStep.metadata as any) || {}
      const targetInRoutes = targetMetadata.inRoutes || {}
      
      // Remove source step from target's prevStepIds
      const updatedTargetPrevStepIds = (targetStep.prevStepIds || []).filter(id => id !== source.step_id)
      
      // Remove source step from specific inRoute
      const updatedTargetInRoutes = { ...targetInRoutes }
      const targetRouteKey = `in${target.route}`
      if (updatedTargetInRoutes[targetRouteKey]) {
        updatedTargetInRoutes[targetRouteKey] = updatedTargetInRoutes[targetRouteKey].filter((id: string) => id !== source.step_id)
        // Remove empty route arrays
        if (updatedTargetInRoutes[targetRouteKey].length === 0) {
          delete updatedTargetInRoutes[targetRouteKey]
        }
      }

      await tx
        .update(workflowStepTemplate)
        .set({
          prevStepIds: updatedTargetPrevStepIds,
          metadata: {
            ...targetMetadata,
            inRoutes: updatedTargetInRoutes
          },
          updatedAt: new Date()
        })
        .where(eq(workflowStepTemplate.id, target.step_id))

      return {
        removedConnection: {
          source: {
            step_id: source.step_id,
            route: source.route
          },
          target: {
            step_id: target.step_id,
            route: target.route
          }
        },
        updatedSourceStep: source.step_id,
        updatedTargetStep: target.step_id
      }
    })

    Logger.info(`✅ Removed connection from step ${source.step_id}:${source.route} to step ${target.step_id}:${target.route}`)

    return c.json({
      success: true,
      data: result,
      message: "Link removed successfully"
    })
    
  } catch (error) {
    Logger.error(error, "Failed to delete link")
    const statusCode = (error as any).statusCode || 500
    return c.json({
      success: false,
      message: getErrorMessage(error),
    }, statusCode)
  }
}
