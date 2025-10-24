import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { WorkflowStatus, StepType, ToolType, ToolExecutionStatus } from "@/types/workflowTypes"
import { type SelectAgent } from "../db/schema"
import { type ExecuteAgentResponse } from "./agent/workflowAgentUtils"


// Schema for workflow executions query parameters
const listWorkflowExecutionsQuerySchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  from_date: z.string().optional(), // ISO date string
  to_date: z.string().optional(), // ISO date string
  limit: z.coerce.number().min(1).max(100).optional().default(10),
  page: z.coerce.number().min(1).optional().default(1),
})
import { ExecuteAgentForWorkflow, executeAgentForWorkflowWithRag } from "./agent/workflowAgentUtils"
import { db } from "@/db/client"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowExecution,
  workflowStepExecution,
  workflowTool,
  toolExecution,
  createWorkflowTemplateSchema,
  createComplexWorkflowTemplateSchema,
  createWorkflowToolSchema,
  executeWorkflowSchema,
  updateWorkflowTemplateSchema,
  createWorkflowExecutionSchema,
  updateWorkflowExecutionSchema,
  updateWorkflowStepExecutionSchema,
  formSubmissionSchema,
} from "@/db/schema/workflows"
import { getUserByEmail, getUserFromJWT } from "@/db/user"
import { createAgentForWorkflow } from "./agent/workflowAgentUtils"
import { type CreateAgentPayload } from "./agent"
import {
  eq,
  sql,
  inArray,
  and,
  or,
  gte,
  lte,
  ilike,
  desc,
  asc,
  ne,
} from "drizzle-orm"

import { type AttachmentMetadata } from "@/shared/types"
import { webhookRegistry } from "@/services/webhookRegistry"
import webhookIntegrationService from "@/services/webhookIntegrationService"
import { hasWebhookTools, triggerWebhookReload } from "@/services/webhookReloadService"

// Re-export schemas for server.ts
export {
  createWorkflowTemplateSchema,
  createComplexWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  createWorkflowExecutionSchema,
  updateWorkflowExecutionSchema,
  createWorkflowToolSchema,
  updateWorkflowStepExecutionSchema,
  formSubmissionSchema,
} from "@/db/schema/workflows"

// Export query schema
export { listWorkflowExecutionsQuerySchema }
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { getErrorMessage } from "@/utils"
import { handleAttachmentUpload } from "@/api/files"
import {
  handleWorkflowFileUpload,
  validateFormData,
  buildValidationSchema,
  type WorkflowFileData,
  type AttachmentUploadResponse,
  type WorkflowFileUpload,
} from "@/api/workflowFileHandler"



const loggerWithChild = getLoggerWithChild(Subsystem.WorkflowApi)
const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.WorkflowApi)

// New Workflow API Routes
export const workflowRouter = new Hono()



// Utility function to extract attachment IDs from form data
const extractAttachmentIds = (formData: Record<string, any>): {
  imageAttachmentIds: string[]
  documentAttachmentIds: string[]
} => {
  const imageIds: string[] = []
  const documentIds: string[] = []

  Object.entries(formData).forEach(([key, file]) => {
    // More defensive checking
    if (file &&
      typeof file === 'object' &&
      file !== null &&
      'attachmentId' in file &&
      file.attachmentId) {

      Logger.info(`Processing field ${key} with attachment ID: ${file.attachmentId}`)


      if ('attachmentMetadata' in file && file.attachmentMetadata) {
        const metadata = file.attachmentMetadata as AttachmentMetadata
        if (metadata.isImage) {
          imageIds.push(file.attachmentId)
        } else {
          documentIds.push(file.attachmentId)
        }
      } else {
        // Fallback: assume non-image if no metadata
        Logger.warn(`No attachmentMetadata found for ${key}, assuming document`)
        documentIds.push(file.attachmentId)
      }
    }
  })

  return { imageAttachmentIds: imageIds, documentAttachmentIds: documentIds }
}


// List all workflow templates with root step details
export const ListWorkflowTemplatesApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(
      db,
      c.get(JwtPayloadKey)
    )
    const templates = await db
      .select()
      .from(workflowTemplate)
      .where(and(
        eq(workflowTemplate.workspaceId, user.workspaceId),
        or(
          eq(workflowTemplate.isPublic, true),
          eq(workflowTemplate.userId, user.id),
        )
      ))

    // Get step templates and root step details for each workflow
    const templatesWithSteps = await Promise.all(
      templates.map(async (template) => {
        const steps = await db
          .select()
          .from(workflowStepTemplate)
          .where(eq(workflowStepTemplate.workflowTemplateId, template.id))

        // Get root step details with single tool (not array)
        let rootStep = null
        if (template.rootWorkflowStepTemplateId) {
          const rootStepResult = steps.find(
            (s) => s.id === template.rootWorkflowStepTemplateId,
          )
          if (rootStepResult) {
            const rootStepToolIds = rootStepResult.toolIds || []
            let rootStepTool = null

            if (rootStepToolIds.length > 0) {
              const rootStepTools = await db
                .select()
                .from(workflowTool)
                .where(inArray(workflowTool.id, rootStepToolIds))
              rootStepTool = rootStepTools.length > 0 ? rootStepTools[0] : null
            }

            rootStep = {
              id: rootStepResult.id,
              workflowTemplateId: rootStepResult.workflowTemplateId,
              name: rootStepResult.name,
              description: rootStepResult.description,
              type: rootStepResult.type,
              timeEstimate: rootStepResult.timeEstimate,
              metadata: rootStepResult.metadata,
              tool: rootStepTool,
            }
          }
        }

        return {
          ...template,
          rootStep,
        }
      }),
    )

    return c.json({
      success: true,
      data: templatesWithSteps,
    })
  } catch (error) {
    Logger.error(error, "Failed to list workflow templates")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get specific workflow template
export const GetWorkflowTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(
      db,
      c.get(JwtPayloadKey)
    )
    const templateId = c.req.param("templateId")

    const template = await db
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

    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    const toolIds = steps.flatMap((s) => s.toolIds || [])
    const tools =
      toolIds.length > 0
        ? await db
          .select()
          .from(workflowTool)
          .where(inArray(workflowTool.id, toolIds))
        : []

    return c.json({
      success: true,
      data: {
        ...template[0],
        steps,
        workflow_tools: tools,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Execute workflow template with root step input
export const ExecuteWorkflowWithInputApi = async (c: Context) => {
  let email: string = ""
  let via_apiKey = false
  try {
    const jwtPayload = c.get(JwtPayloadKey)
    const user = await getUserFromJWT(db, jwtPayload)
    const userId = user.id
    const workspaceExternalId = jwtPayload.workspaceId

    Logger.debug(`Debug-ExecuteWorkflowWithInputApi: userId=${userId}, workspaceInternalId=${user.workspaceId}, workspaceExternalId=${workspaceExternalId}`)

    const templateId = c.req.param("templateId")
    const contentType = c.req.header("content-type") || ""

    let requestData: any = {}
    let hasFileUploads = false

    // Handle both JSON and multipart form data
    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData()
      Logger.debug(`Received multipart/form-data request with ${formData} `)
      const entries: [string, FormDataEntryValue][] = []
      formData.forEach((value, key) => {
        entries.push([key, value])
      })

      requestData.rootStepInput = {}
      for (const [key, value] of entries) {
        if (key === "name" || key === "description") {
          requestData[key] = value as string
        } else if (typeof value === "string") {
          requestData.rootStepInput[key] = value
        } else if (value instanceof File) {
          // We'll handle file uploads after validation
          requestData.rootStepInput[key] = value
          hasFileUploads = true
        }
      }
    } else {
      requestData = await c.req.json()
    }

    // Validate required fields
    if (!requestData.rootStepInput) {
      throw new HTTPException(400, { message: "rootStepInput is required" })
    }

    // Get template and validate (allow access to user's own or public templates)
    const template = await db
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
    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    if (!template[0].rootWorkflowStepTemplateId) {
      throw new HTTPException(400, {
        message: "Template has no root step configured",
      })
    }

    // Get root step template
    const rootStepTemplate = await db
      .select()
      .from(workflowStepTemplate)
      .where(
        eq(workflowStepTemplate.id, template[0].rootWorkflowStepTemplateId),
      )

    if (!rootStepTemplate || rootStepTemplate.length === 0) {
      throw new HTTPException(404, { message: "Root step template not found" })
    }

    const rootStep = rootStepTemplate[0]

    // Get root step tool for validation
    let rootStepTool = null
    if (rootStep.toolIds && rootStep.toolIds.length > 0) {
      const toolResult = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, rootStep.toolIds[0]))

      if (toolResult && toolResult.length > 0) {
        rootStepTool = toolResult[0]
      }
    }

    // Validate input based on root step type
    if (rootStep.type === StepType.MANUAL && rootStepTool?.type === ToolType.FORM) {
      // Validate form input
      const formDefinition = rootStepTool.value as any
      const formFields = formDefinition?.fields || []

      // Build validation schema
      const validationSchema = buildValidationSchema(formFields)

      // Handle file uploads if present
      if (contentType.includes("multipart/form-data")) {
        // Validate non-file fields first
        const nonFileData = { ...requestData.rootStepInput }
        const nonFileValidationSchema = { ...validationSchema }

        // Remove file fields from initial validation
        for (const field of formFields) {
          if (field.type === "file") {
            delete nonFileValidationSchema[field.id]
          }
        }

        const validationResult = validateFormData(
          nonFileData,
          nonFileValidationSchema,
        )
        if (!validationResult.isValid) {
          throw new HTTPException(400, {
            message: `Root step input validation failed: ${validationResult.errors.join(", ")}`,
          })
        }

      } else {
        // JSON validation (no files)
        const validationResult = validateFormData(
          requestData.rootStepInput,
          validationSchema,
        )
        if (!validationResult.isValid) {
          throw new HTTPException(400, {
            message: `Root step input validation failed: ${validationResult.errors.join(", ")}`,
          })
        }
      }
    } else if (rootStep.type === StepType.AUTOMATED) {
      // For automated steps, no input validation needed
      if (Object.keys(requestData.rootStepInput).length > 0) {
        throw new HTTPException(400, {
          message: "Automated root steps should not have input data",
        })
      }
    }

    // Create workflow execution
    //Workflow TODO : currently in metadata we are passing userEmail, workspaceId, userId, workspaceInternalId, but after db changes we can directly fetch userId and workspaceId from workflowExecution tablexw
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: template[0].id,
        userId: userId,
        workspaceId: user.workspaceId,
        name:
          requestData.name ||
          `${template[0].name} - ${new Date().toLocaleDateString()}`,
        description:
          requestData.description || `Execution of ${template[0].name}`,
        metadata: {
          ...requestData.metadata,
          executionContext: {
            userEmail: user.email,
            workspaceId: workspaceExternalId,
          }
        },
        status: WorkflowStatus.ACTIVE,
        rootWorkflowStepExeId: null,
      })
      .returning()

    // Get all step templates
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Create step executions for all template steps
    const stepExecutionsData = steps.map((step) => ({
      workflowExecutionId: execution.id,
      workflowStepTemplateId: step.id,
      name: step.name,
      type: step.type,
      status: WorkflowStatus.DRAFT as const,
      parentStepId: step.parentStepId,
      prevStepIds: step.prevStepIds || [],
      nextStepIds: step.nextStepIds || [],
      toolExecIds: [],
      timeEstimate: step.timeEstimate,
      metadata: step.metadata,
    }))

    const stepExecutions = await db
      .insert(workflowStepExecution)
      .values(stepExecutionsData)
      .returning()

    // Find root step execution
    const rootStepExecution = stepExecutions.find(
      (se) =>
        se.workflowStepTemplateId === template[0].rootWorkflowStepTemplateId,
    )

    if (!rootStepExecution) {
      throw new HTTPException(500, {
        message: "Failed to create root step execution",
      })
    }

    // Update workflow with root step execution ID
    await db
      .update(workflowExecution)
      .set({ rootWorkflowStepExeId: rootStepExecution.id })
      .where(eq(workflowExecution.id, execution.id))

    // Process file uploads and create tool execution
    let toolExecutionRecord = null
    let processedFormData = { ...requestData.rootStepInput }

    if (rootStepTool) {
      // Handle file uploads if present
      if (
        contentType.includes("multipart/form-data") &&
        rootStepTool.type === ToolType.FORM
      ) {
        const formDefinition = rootStepTool.value as any
        const formFields = formDefinition?.fields || []

        // Process file uploads
        for (const field of formFields) {
          if (field.type === "file") {
            const file = requestData.rootStepInput[field.id]

            if (file instanceof File) {
              try {
                const fileValidation = buildValidationSchema(formFields)[field.id]?.fileValidation
                let finalProcessedData: WorkflowFileData = {
                  originalFileName: file.name,
                  fileName: file.name,
                  fileSize: file.size,
                  mimetype: file.type,
                  uploadedAt: new Date().toISOString(),
                  uploadedBy: "api",
                  fileExtension: file.name.split('.').pop() || '',
                  workflowExecutionId: execution.id,
                  workflowStepId: rootStepExecution.id,
                }

                try {
                  // Create FormData for handleAttachmentUpload
                  const attachmentFormData = new FormData()
                  attachmentFormData.append('attachment', file)

                  // Create mock context with JWT payload for handleAttachmentUpload
                  //Workflow-TODO: instead of creating mock context, we should create a helper function inside handleAttachmentUpload to accept params directly, or need to refactor handleAttachmentUpload to be more modular
                  const mockContext = {
                    req: {
                      formData: async () => attachmentFormData
                    },
                    get: (key: string) => {
                      if (key === JwtPayloadKey) {
                        return {
                          sub: user.email,
                          workspaceId: workspaceExternalId
                        }
                      }
                      return undefined
                    },
                    json: (data: any, status?: number) => {
                      return data
                    }
                  } as Context

                  // workflow-TODO: add multifile Support 
                  // call handleAttachmentUpload which store files in vespa and images in downloads/xyne_images_db
                  const attachmentResult = await handleAttachmentUpload(mockContext) as unknown as AttachmentUploadResponse


                  if (attachmentResult && typeof attachmentResult === 'object' && 'attachments' in attachmentResult) {
                    const attachments: AttachmentMetadata[] = attachmentResult.attachments
                    if (Array.isArray(attachments) && attachments.length > 0) {
                      const attachmentId = attachments[0].fileId
                      finalProcessedData = {
                        ...finalProcessedData,
                        attachmentId: attachmentId,
                        attachmentMetadata: attachments[0]
                      }
                    }
                  } else {
                    Logger.warn(`handleAttachmentUpload did not return expected attachments array for field ${field.id}`)
                  }
                } catch (attachmentError) {
                  Logger.error(
                    attachmentError,
                    `handleAttachmentUpload failed for field ${field.id}, continuing with workflow file upload only`,
                  )
                }

                processedFormData[field.id] = finalProcessedData

              } catch (uploadError) {
                Logger.error(
                  uploadError,
                  `File upload failed for field ${field.id}`,
                )
                throw new HTTPException(400, {
                  message: `File upload failed for ${field.id}: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
                })
              }
            }
          }
        }
      }

      ;[toolExecutionRecord] = await db
        .insert(toolExecution)
        .values({
          workflowToolId: rootStepTool.id,
          workflowExecutionId: execution.id,
          status: ToolExecutionStatus.COMPLETED,
          result: {
            formData: processedFormData,
            submittedAt: new Date().toISOString(),
            submittedBy: "api",
            autoCompleted: true,
          },
          startedAt: new Date(),
          completedAt: new Date(),
        })
        .returning()
    }

    // Mark root step as completed
    await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: "api",
        completedAt: new Date(),
        toolExecIds: toolExecutionRecord ? [toolExecutionRecord.id] : [],
        metadata: {
          ...(rootStepExecution.metadata || {}),
          formSubmission: {
            formData: processedFormData,
            submittedAt: new Date().toISOString(),
            submittedBy: "api",
            autoCompleted: true,
          },
        },
      })
      .where(eq(workflowStepExecution.id, rootStepExecution.id))

    // Auto-execute next automated steps
    const allTools = await db
      .select()
      .from(workflowTool)
      .where(
        and(
          eq(workflowTool.workspaceId, user.workspaceId),
          eq(workflowTool.userId, user.id),
        ),
      )
    const rootStepName = rootStepExecution.name || "Root Step"
    const currentResults: Record<string, any> = {}

    currentResults[rootStepName] = {
      stepId: rootStepExecution.id,
      formSubmission: {
        formData: processedFormData,
        submittedAt: new Date().toISOString(),
        submittedBy: "api",
        autoCompleted: true,
      },
      toolExecution: toolExecutionRecord,
    }

    // Return response immediately and execute automated steps in parallel
    const responseData = {
      success: true,
      message:
        "Workflow started successfully - automated steps running in background",
      data: {
        execution: {
          ...execution,
          rootWorkflowStepExeId: rootStepExecution.id,
        },
        rootStepExecution: {
          ...rootStepExecution,
          status: ToolExecutionStatus.COMPLETED,
        },
        toolExecution: toolExecutionRecord,
        statusPollingUrl: `/api/v1/workflow/executions/${execution.id}/status`,
      },
    }

    // Execute automated steps in background (non-blocking)
    if (
      rootStepExecution.nextStepIds &&
      Array.isArray(rootStepExecution.nextStepIds)
    ) {
      // Run automated execution in background without waiting
      executeAutomatedWorkflowSteps(
        execution.id,
        rootStepExecution.nextStepIds,
        stepExecutions,
        allTools,
        currentResults,
      ).catch((error) => {
        Logger.error(
          error,
          `Background workflow execution failed for ${execution.id}`,
        )
      })
    }

    return c.json(responseData)
  } catch (error) {
    Logger.error(error, "Failed to execute workflow with input")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Execute workflow template
export const ExecuteWorkflowTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const templateId = c.req.param("templateId")
    const requestData = await c.req.json()

    // Get template
    const template = await db
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

    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    // Get step templates
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Get tools
    const tools = await db
      .select()
      .from(workflowTool)
      .where(and(
        eq(workflowTool.workspaceId, user.workspaceId),
        eq(workflowTool.userId, user.id),
      ))



    // Create workflow execution
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: template[0].id,
        userId: user.id,
        workspaceId: user.workspaceId,
        name:
          requestData.name ||
          `${template[0].name} - ${new Date().toLocaleDateString()}`,
        description:
          requestData.description || `Execution of ${template[0].name}`,
        metadata: requestData.metadata || {},
        status: WorkflowStatus.ACTIVE,
        rootWorkflowStepExeId: null,
      })
      .returning()

    // Create step executions for all template steps
    const stepExecutionsData = steps.map((step) => ({
      workflowExecutionId: execution.id,
      workflowStepTemplateId: step.id,
      name: step.name,
      type: step.type,
      status: WorkflowStatus.DRAFT as const,
      parentStepId: step.parentStepId,
      prevStepIds: step.prevStepIds || [],
      nextStepIds: step.nextStepIds || [],
      toolExecIds: [], // Will be populated when tools are executed
      timeEstimate: step.timeEstimate,
      metadata: step.metadata,
    }))

    const stepExecutions = await db
      .insert(workflowStepExecution)
      .values(stepExecutionsData)
      .returning()

    // Find root step (no parent)
    const rootStepExecution = stepExecutions.find((se) => {
      const originalStep = steps.find((s) => s.id === se.workflowStepTemplateId)
      return !originalStep?.parentStepId
    })

    if (rootStepExecution) {
      await db
        .update(workflowExecution)
        .set({ rootWorkflowStepExeId: rootStepExecution.id })
        .where(eq(workflowExecution.id, execution.id))
    }

    // Auto-execute workflow starting from root step if it's automated
    let executionResults = {}

    if (rootStepExecution && rootStepExecution.type === StepType.AUTOMATED) {
      executionResults = await executeWorkflowChain(
        execution.id,
        rootStepExecution.id,
        tools,
        {},
      )
    }

    return c.json({
      success: true,
      message: "Workflow created and auto-execution started",
      data: {
        execution: {
          ...execution,
          rootWorkflowStepExeId: rootStepExecution?.id,
        },
        stepExecutions: stepExecutions,
        executionResults: executionResults,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to execute workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Improved workflow completion logic that only considers executed steps
const checkAndUpdateWorkflowCompletion = async (executionId: string) => {
  try {
    // Get current workflow execution
    const [currentExecution] = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

    if (!currentExecution || currentExecution.status === WorkflowStatus.COMPLETED || currentExecution.status === WorkflowStatus.FAILED) {
      return false // Already completed or failed, no update needed
    }

    // Get all step executions for this workflow
    const allStepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    // Filter steps that are part of the actual execution path
    // A step is considered "in execution path" if:
    // 1. It has been started (status is not "draft")
    // 2. OR it's the root step
    // 3. OR it has completed tool executions
    const executedSteps = allStepExecutions.filter(step => {
      const isRootStep = currentExecution.rootWorkflowStepExeId === step.id
      const hasBeenStarted = step.status !== WorkflowStatus.DRAFT
      const hasToolExecutions = step.toolExecIds && step.toolExecIds.length > 0

      return isRootStep || hasBeenStarted || hasToolExecutions
    })

    Logger.info(
      `Workflow ${executionId}: ${executedSteps.length} executed steps out of ${allStepExecutions.length} total steps`
    )

    // Check completion conditions
    const completedSteps = executedSteps.filter(step => step.status === WorkflowStatus.COMPLETED)
    const failedSteps = executedSteps.filter(step => step.status === WorkflowStatus.FAILED)
    const activeSteps = executedSteps.filter(step => step.status === WorkflowStatus.ACTIVE)
    const manualStepsAwaitingInput = executedSteps.filter(step =>
      step.type === StepType.MANUAL && step.status === WorkflowStatus.DRAFT
    )

    Logger.info(
      `Workflow ${executionId} status: ${completedSteps.length} completed, ${failedSteps.length} failed, ${activeSteps.length} active, ${manualStepsAwaitingInput.length} awaiting input`
    )

    // Update workflow metadata with execution progress
    const progressMetadata = {
      ...(currentExecution.metadata || {}),
      executionProgress: {
        totalSteps: allStepExecutions.length,
        executedSteps: executedSteps.length,
        completedSteps: completedSteps.length,
        failedSteps: failedSteps.length,
        activeSteps: activeSteps.length,
        manualStepsAwaitingInput: manualStepsAwaitingInput.length,
        lastUpdated: new Date().toISOString()
      }
    }

    // Determine if workflow should be marked as completed
    let shouldComplete = false
    let completionReason = ""

    if (failedSteps.length > 0) {
      // If any executed step failed, mark workflow as failed
      await db
        .update(workflowExecution)
        .set({
          status: "failed",
          completedAt: new Date(),
          completedBy: "system",
          metadata: progressMetadata
        })
        .where(eq(workflowExecution.id, executionId))

      Logger.info(`Workflow ${executionId} marked as failed due to ${failedSteps.length} failed steps`)
      return true
    }

    if (executedSteps.length === 0) {
      // No steps have been executed yet, workflow is not complete
      shouldComplete = false
    } else if (completedSteps.length === executedSteps.length) {
      // All executed steps are completed
      shouldComplete = true
      completionReason = "All executed steps completed"
    } else if (activeSteps.length === 0 && manualStepsAwaitingInput.length === 0) {
      // No active steps and no manual steps awaiting input
      // This means we've reached the end of the execution path
      shouldComplete = true
      completionReason = "End of execution path reached"
    } else {
      // There are still active steps or manual steps awaiting input
      shouldComplete = false
    }

    // Update workflow metadata with current progress
    await db
      .update(workflowExecution)
      .set({
        metadata: progressMetadata,
        updatedAt: new Date()
      })
      .where(eq(workflowExecution.id, executionId))

    if (shouldComplete) {
      Logger.info(
        `Workflow ${executionId} completion criteria met: ${completionReason}`
      )

      await db
        .update(workflowExecution)
        .set({
          status: ToolExecutionStatus.COMPLETED,
          completedAt: new Date(),
          completedBy: "system",
          metadata: progressMetadata
        })
        .where(eq(workflowExecution.id, executionId))

      Logger.info(`Workflow ${executionId} marked as completed`)
      return true
    }

    return false
  } catch (error) {
    Logger.error(error, `Failed to check workflow completion for ${executionId}`)
    return false
  }
}

// Execute automated workflow steps in background
const executeAutomatedWorkflowSteps = async (
  executionId: string,
  nextStepTemplateIds: string[],
  stepExecutions: any[],
  allTools: any[],
  currentResults: any,
) => {
  try {
    Logger.info(
      `Starting background execution of automated steps for workflow ${executionId}`,
    )

    let executionResults = currentResults

    //todo : this is the normal for loop, we need to think about parallel execution of independent steps
    for (const nextStepTemplateId of nextStepTemplateIds) {
      const nextStep = stepExecutions.find(
        (s) => s.workflowStepTemplateId === nextStepTemplateId,
      )

      if (nextStep && nextStep.type === StepType.AUTOMATED) {
        Logger.info(
          `Executing automated step: ${nextStep.name} (${nextStep.id})`,
        )
        try {
          executionResults = await executeWorkflowChain(
            executionId,
            nextStep.id,
            allTools,
            executionResults,
          )
        } catch (stepError) {
          // Step execution failed, workflow should already be marked as failed
          // Stop processing remaining steps
          Logger.error(`Step execution failed, stopping workflow execution: ${stepError}`)
          throw stepError
        }
      }
    }

    // Check if workflow is completed after background execution
    const updatedStepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    const allStepsCompleted = updatedStepExecutions.every(
      (step) => step.status === WorkflowStatus.COMPLETED,
    )

    if (allStepsCompleted) {
      Logger.info(
        `All steps completed for workflow execution ${executionId}, marking as completed`,
      )
      await db
        .update(workflowExecution)
        .set({
          status: ToolExecutionStatus.COMPLETED,
          completedAt: new Date(),
          completedBy: "system",
        })
        .where(eq(workflowExecution.id, executionId))
    }

    Logger.info(`Background workflow execution completed for ${executionId}`)
    return executionResults
  } catch (error) {
    Logger.error(
      error,
      `Background workflow execution failed for ${executionId}`,
    )

    // Check if workflow is already marked as failed before updating
    try {
      const [currentExecution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))

      if (currentExecution && currentExecution.status !== WorkflowStatus.FAILED) {
        // Only mark as failed if not already failed (to avoid overriding specific failure info)
        await db
          .update(workflowExecution)
          .set({
            status: "failed",
            completedAt: new Date(),
            completedBy: "system",
          })
          .where(eq(workflowExecution.id, executionId))
        Logger.info(`Workflow ${executionId} marked as failed due to background execution error`)
      } else {
        Logger.info(`Workflow ${executionId} already marked as failed, skipping status update`)
      }
    } catch (dbError) {
      Logger.error(dbError, `Failed to check or update workflow ${executionId} status`)
    }

    throw error
  }
}

// Execute workflow chain - automatically execute steps in sequence
export const executeWorkflowChain = async (
  executionId: string,
  currentStepId: string,
  tools: any[],
  previousResults: any,
) => {
  try {
    Logger.info(`🚀 executeWorkflowChain called:`, {
      executionId,
      currentStepId,
      toolCount: tools.length,
      previousResultsKeys: Object.keys(previousResults || {})
    })

    // Get current step execution
    const stepExecution = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.id, currentStepId))
    if (!stepExecution || stepExecution.length === 0) {
      return previousResults
    }

    const step = stepExecution[0]

    // Check if this is a webhook-triggered execution (get this first)
    const [execution] = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

    // Check if step is already completed (e.g., webhook step completed at creation)
    if (step.status === WorkflowStatus.COMPLETED) {
      Logger.info(`⏭️ Step already completed, loading results: ${step.name} (${step.id})`)
      
      // Get completed tool execution results for this step execution
      const toolExecutions = await db
        .select()
        .from(toolExecution)
        .where(eq(toolExecution.workflowExecutionId, step.id))
      
      Logger.info(`🔍 Looking for tool executions for step ${step.id}, found: ${toolExecutions.length}`)
      
      if (toolExecutions.length > 0) {
        const completedResult = toolExecutions[0].result
        Logger.info(`📋 Completed result for ${step.name}:`, {
          hasResult: !!completedResult,
          resultKeys: Object.keys(completedResult || {}),
          resultSample: completedResult ? JSON.stringify(completedResult).substring(0, 200) : 'null'
        })
        
        const stepResults = {
          stepId: step.id,
          result: completedResult,
          toolExecution: toolExecutions[0],
          status: 'success',
          toolType: 'webhook'
        }
        
        const updatedResults = {
          ...(previousResults || {}),
          [step.name]: stepResults,
        }
        
        Logger.info(`📊 Loaded completed step results for '${step.name}':`, {
          stepType: 'webhook',
          status: 'completed',
          hasResult: !!completedResult,
          resultKeys: Object.keys(completedResult || {}),
          totalSteps: Object.keys(updatedResults).length
        })
        
        // Continue to next steps since this one is done
        if (step.nextStepIds && Array.isArray(step.nextStepIds)) {
          Logger.info(`🔗 Found ${step.nextStepIds.length} next step(s) from completed step:`, step.nextStepIds)
          
          for (const nextStepId of step.nextStepIds) {
            const nextSteps = await db
              .select()
              .from(workflowStepExecution)
              .where(eq(workflowStepExecution.workflowExecutionId, executionId))

            const nextStep = nextSteps.find(
              (s) => s.workflowStepTemplateId === nextStepId,
            )

            if (nextStep) {
              const isWebhookTriggered = execution?.metadata && 
                (execution.metadata as any).triggerType === 'webhook'
              
              const shouldExecute = nextStep.type === StepType.AUTOMATED || isWebhookTriggered
              
              if (shouldExecute) {
                Logger.info(`⏭️ Executing next step from completed step: ${nextStep.name} (${nextStep.id})`)
                await executeWorkflowChain(
                  executionId,
                  nextStep.id,
                  tools,
                  updatedResults,
                )
              } else {
                Logger.info(`⏸️ Skipping manual step: ${nextStep.name} (${nextStep.type})`)
              }
            } else {
              Logger.warn(`⚠️ Next step not found for template ID: ${nextStepId}`)
            }
          }
        } else {
          Logger.info(`🏁 No next steps found for completed step '${step.name}'`)
        }
        
        return updatedResults
      } else {
        Logger.warn(`⚠️ No tool executions found for completed step ${step.name} (${step.id})`)
        
        // For webhook steps, provide dummy data to keep workflow running
        if (step.name.toLowerCase().includes('webhook')) {
          Logger.info(`🔄 Creating dummy webhook data for ${step.name} to continue workflow`)
          
          const dummyWebhookData = {
            webhook: {
              method: "POST",
              url: "http://localhost:3000/workflow/webhook/test1",
              path: "/test1",
              headers: { "Content-Type": "application/json" },
              query: {},
              body: { message: "Test webhook trigger", timestamp: new Date().toISOString() },
              timestamp: new Date().toISOString(),
              curl: `curl -X POST -H "Content-Type: application/json" -d '{"message":"Test webhook trigger"}' "http://localhost:3000/workflow/webhook/test1"`
            },
            aiOutput: `Webhook Request Analysis:

Method: POST
URL: http://localhost:3000/workflow/webhook/test1
Path: /test1
Timestamp: ${new Date().toISOString()}

Headers:
{
  "Content-Type": "application/json"
}

Query Parameters:
{}

Request Body:
{
  "message": "Test webhook trigger",
  "timestamp": "${new Date().toISOString()}"
}

cURL Command:
curl -X POST -H "Content-Type: application/json" -d '{"message":"Test webhook trigger"}' "http://localhost:3000/workflow/webhook/test1"

Please analyze this webhook request and provide insights.`,
            content: "Test webhook data for workflow execution",
            output: "Test webhook output",
            input: {
              aiOutput: "Test webhook data for AI analysis",
              content: "Test webhook content",
              summary: "Webhook received: POST request to /test1",
              data: { message: "Test webhook trigger" }
            },
            data: { message: "Test webhook trigger", timestamp: new Date().toISOString() },
            status: 'success',
            message: 'Test webhook triggered for workflow execution'
          }
          
          const stepResults = {
            stepId: step.id,
            result: dummyWebhookData,
            toolExecution: null,
            status: 'success',
            toolType: 'webhook'
          }
          
          const updatedResults = {
            ...(previousResults || {}),
            [step.name]: stepResults,
          }
          
          Logger.info(`📊 Created dummy webhook data for '${step.name}' to continue workflow`)
          
          // Continue to next steps with dummy data
          if (step.nextStepIds && Array.isArray(step.nextStepIds)) {
            for (const nextStepId of step.nextStepIds) {
              const nextSteps = await db
                .select()
                .from(workflowStepExecution)
                .where(eq(workflowStepExecution.workflowExecutionId, executionId))

              const nextStep = nextSteps.find(
                (s) => s.workflowStepTemplateId === nextStepId,
              )

              if (nextStep) {
                const isWebhookTriggered = execution?.metadata && 
                  (execution.metadata as any).triggerType === 'webhook'
                
                const shouldExecute = nextStep.type === StepType.AUTOMATED || isWebhookTriggered
                
                if (shouldExecute) {
                  Logger.info(`⏭️ Executing next step with dummy data: ${nextStep.name} (${nextStep.id})`)
                  await executeWorkflowChain(
                    executionId,
                    nextStep.id,
                    tools,
                    updatedResults,
                  )
                }
              }
            }
          }
          
          return updatedResults
        }
        
        // If no tool executions found, let it continue to normal execution path
      }
    }
    
    const isWebhookTriggered = execution?.metadata && 
      (execution.metadata as any).triggerType === 'webhook'

    // If step is manual and not webhook-triggered, wait for user input
    if (step.type === StepType.MANUAL && !isWebhookTriggered) {
      Logger.info(`⏸️ Manual step encountered, waiting for user input: ${step.name}`)
      return previousResults
    }

    // Get the tool for this step from the step template (not execution)
    const stepTemplate = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, step.workflowStepTemplateId))
    if (!stepTemplate || stepTemplate.length === 0) {
      return previousResults
    }

    const toolIds = stepTemplate[0].toolIds || []
    const toolId = toolIds.length > 0 ? toolIds[0] : null
    if (!toolId) {
      return previousResults
    }

    const tool = tools.find((t) => t.id === toolId)
    if (!tool) {
      Logger.warn(`🔍 Tool not found for ID: ${toolId}. Available tools: ${tools.map(t => `${t.id}:${t.type}`).join(', ')}`)
      return previousResults
    }

    Logger.info(`🔧 Executing tool: ${tool.type} (${tool.id}) for step: ${step.name}`)

    // Execute the tool
    const toolResult = await executeWorkflowTool(tool, previousResults, executionId)

    // Check if tool execution failed
    if (toolResult.status !== "success") {
      Logger.error(`Tool execution failed for step ${step.name}: ${JSON.stringify(toolResult.result)}`)

      // Create failed tool execution record
      let toolExecutionRecord
      try {
        const [execution] = await db
          .insert(toolExecution)
          .values({
            workflowToolId: tool.id,
            workflowExecutionId: executionId,
            status: "failed",
            result: toolResult.result,
            startedAt: new Date(),
            completedAt: new Date(),
          })
          .returning()
        toolExecutionRecord = execution
      } catch (dbError) {
        Logger.warn(`Database insert failed for failed tool, creating minimal record: ${dbError}`)
        const [execution] = await db
          .insert(toolExecution)
          .values({
            workflowToolId: tool.id,
            workflowExecutionId: executionId,
            status: "failed",
            result: {
              error: "Tool execution failed and result could not be stored",
              original_error: "Database storage failed"
            },
            startedAt: new Date(),
            completedAt: new Date(),
          })
          .returning()
        toolExecutionRecord = execution
      }

      // Mark step as failed
      await db
        .update(workflowStepExecution)
        .set({
          status: "failed",
          completedBy: "system",
          completedAt: new Date(),
          toolExecIds: [toolExecutionRecord.id],
        })
        .where(eq(workflowStepExecution.id, currentStepId))

      // Mark workflow as failed
      await db
        .update(workflowExecution)
        .set({
          status: "failed",
          completedAt: new Date(),
          completedBy: "system",
        })
        .where(eq(workflowExecution.id, executionId))

      Logger.error(`Workflow ${executionId} marked as failed due to step ${step.name} failure`)

      // Return error result to stop further execution
      throw new Error(`Step "${step.name}" failed: ${JSON.stringify(toolResult.result)}`)
    }

    // Create tool execution record with error handling for unicode issues
    let toolExecutionRecord
    try {
      const [execution] = await db
        .insert(toolExecution)
        .values({
          workflowToolId: tool.id,
          workflowExecutionId: executionId,
          status: ToolExecutionStatus.COMPLETED,
          result: toolResult.result,
          startedAt: new Date(),
          completedAt: new Date(),
        })
        .returning()
      toolExecutionRecord = execution
    } catch (dbError) {
      // If database insert fails (e.g., unicode issues), sanitize the result and try again
      Logger.warn(`Database insert failed, sanitizing result: ${dbError}`)

      const sanitizedResult = JSON.parse(
        JSON.stringify(toolResult.result)
          .replace(/[\ud800-\udfff]/g, "") // Remove unicode surrogates
          .replace(/[^\x00-\x7F]/g, "?"),
      ) // Replace non-ASCII with ?

      try {
        const [execution] = await db
          .insert(toolExecution)
          .values({
            workflowToolId: tool.id,
            workflowExecutionId: executionId,
            status: ToolExecutionStatus.COMPLETED,
            result: {
              ...sanitizedResult,
              _note: "Result was sanitized due to unicode characters",
              _original_status: toolResult.status,
            },
            startedAt: new Date(),
            completedAt: new Date(),
          })
          .returning()
        toolExecutionRecord = execution
      } catch (secondError) {
        // If it still fails, create a minimal record
        Logger.error(
          `Second database insert failed, creating minimal record: ${secondError}`,
        )
        const [execution] = await db
          .insert(toolExecution)
          .values({
            workflowToolId: tool.id,
            workflowExecutionId: executionId,
            status: ToolExecutionStatus.COMPLETED,
            result: {
              status: "executed_with_db_error",
              message:
                "Tool executed successfully but result could not be stored due to database issues",
              error: "Database storage failed",
            },
            startedAt: new Date(),
            completedAt: new Date(),
          })
          .returning()
        toolExecutionRecord = execution
      }
    }

    // Update step as completed and add tool execution ID
    await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: "system",
        completedAt: new Date(),
        toolExecIds: [toolExecutionRecord.id],
      })
      .where(eq(workflowStepExecution.id, currentStepId))

    Logger.info(`✅ Step marked as COMPLETED: ${step.name} (${step.id}) - Tool: ${tool.type}`)

    // Store results for next step
    const updatedResults = {
      ...(previousResults || {}),
      [step.name]: {
        stepId: step.id,
        result: toolResult.result,
        toolExecution: toolExecutionRecord,
        status: toolResult.status,
        toolType: tool.type,
      },
    }

    Logger.info(`📊 Step results accumulated for '${step.name}':`, {
      stepType: tool.type,
      status: toolResult.status,
      hasResult: !!toolResult.result,
      resultKeys: Object.keys(toolResult.result || {}),
      totalSteps: Object.keys(updatedResults).length
    })

    // Find and execute next steps using UUID arrays - ensuring sequential execution
    if (step.nextStepIds && Array.isArray(step.nextStepIds) && step.nextStepIds.length > 0) {
      Logger.info(`🔗 Found ${step.nextStepIds.length} next step(s) to execute:`, step.nextStepIds)
      
      // Get execution metadata once for efficiency
      const [execution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))
        .limit(1)
      
      const isWebhookTriggered = execution?.metadata && 
        (execution.metadata as any).triggerType === 'webhook'

      // Get all step executions once for efficiency
      const allStepExecutions = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.workflowExecutionId, executionId))

      // Execute steps sequentially to maintain order
      for (let i = 0; i < step.nextStepIds.length; i++) {
        const nextStepId = step.nextStepIds[i]
        
        const nextStep = allStepExecutions.find(
          (s) => s.workflowStepTemplateId === nextStepId,
        )

        if (nextStep) {
          // Execute all steps if webhook-triggered, or only automated steps otherwise
          const shouldExecute = nextStep.type === StepType.AUTOMATED || isWebhookTriggered
          
          if (shouldExecute) {
            Logger.info(`⏭️ Executing next step ${i + 1}/${step.nextStepIds.length}: ${nextStep.name} (${nextStep.id}) - Type: ${nextStep.type}, Webhook: ${isWebhookTriggered}`)
            
            // Recursively execute next step and wait for completion
            try {
              await executeWorkflowChain(
                executionId,
                nextStep.id,
                tools,
                updatedResults,
              )
              
              Logger.info(`✅ Completed step ${i + 1}/${step.nextStepIds.length}: ${nextStep.name}`)
            } catch (stepError) {
              Logger.error(`❌ Failed to execute step ${i + 1}/${step.nextStepIds.length}: ${nextStep.name} - Error: ${stepError}`)
              // Continue with other steps even if one fails
            }
          } else {
            Logger.info(`⏸️ Skipping manual step ${i + 1}/${step.nextStepIds.length}: ${nextStep.name} (${nextStep.type})`)
          }
        } else {
          Logger.warn(`⚠️ Next step ${i + 1}/${step.nextStepIds.length} not found for template ID: ${nextStepId}`)
        }
      }
    } else {
      Logger.info(`🏁 No more steps to execute after '${step.name}' (nextStepIds: ${step.nextStepIds})`)
    }

    // Check if this was the last step and mark workflow as completed if so
    const allStepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    const completedSteps = allStepExecutions.filter(stepExec => stepExec.status === WorkflowStatus.COMPLETED)
    const allStepsCompleted = allStepExecutions.every(
      (stepExec) => stepExec.status === WorkflowStatus.COMPLETED,
    )

    Logger.info(`📊 Workflow progress for ${executionId}: ${completedSteps.length}/${allStepExecutions.length} steps completed`, {
      completed: completedSteps.map(s => s.name),
      remaining: allStepExecutions.filter(s => s.status !== WorkflowStatus.COMPLETED).map(s => `${s.name}(${s.status})`)
    })

    if (allStepsCompleted) {
      // Check if workflow execution is not already completed
      const [currentExecution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))

      if (currentExecution && currentExecution.status !== WorkflowStatus.COMPLETED) {
        Logger.info(
          `🎉 All ${allStepExecutions.length} steps completed for workflow execution ${executionId}, marking workflow as COMPLETED`,
        )
        await db
          .update(workflowExecution)
          .set({
            status: WorkflowStatus.COMPLETED,
            completedAt: new Date(),
            completedBy: "system",
          })
          .where(eq(workflowExecution.id, executionId))
        
        Logger.info(`✅ Workflow ${executionId} marked as COMPLETED successfully`)
      }
    }

    return updatedResults
  } catch (error) {
    Logger.error(error, "Failed to execute workflow chain")
    
    // Even if there's an error, check if we should mark workflow as completed
    try {
      await checkAndCompleteWorkflow(executionId)
    } catch (completionError) {
      Logger.error(`Failed to check workflow completion: ${completionError}`)
    }
    
    return previousResults
  }
}

// Helper function to check and complete workflow if all steps are done
export const checkAndCompleteWorkflow = async (executionId: string) => {
  try {
    const allStepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    const completedSteps = allStepExecutions.filter(stepExec => stepExec.status === WorkflowStatus.COMPLETED)
    const allStepsCompleted = allStepExecutions.every(
      (stepExec) => stepExec.status === WorkflowStatus.COMPLETED,
    )

    Logger.info(`🔍 Checking workflow completion for ${executionId}: ${completedSteps.length}/${allStepExecutions.length} steps completed`, {
      completed: completedSteps.map(s => `${s.name}(${s.status})`),
      remaining: allStepExecutions.filter(s => s.status !== WorkflowStatus.COMPLETED).map(s => `${s.name}(${s.status})`)
    })

    if (allStepsCompleted && allStepExecutions.length > 0) {
      // Check if workflow execution is not already completed
      const [currentExecution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))

      if (currentExecution && currentExecution.status !== WorkflowStatus.COMPLETED) {
        Logger.info(
          `🎉 All ${allStepExecutions.length} steps completed for workflow execution ${executionId}, marking workflow as COMPLETED`,
        )
        await db
          .update(workflowExecution)
          .set({
            status: WorkflowStatus.COMPLETED,
            completedAt: new Date(),
            completedBy: "system",
          })
          .where(eq(workflowExecution.id, executionId))
        
        Logger.info(`✅ Workflow ${executionId} marked as COMPLETED successfully`)
        return true
      } else if (currentExecution?.status === WorkflowStatus.COMPLETED) {
        Logger.info(`✅ Workflow ${executionId} already marked as COMPLETED`)
        return true
      }
    } else {
      Logger.info(`⏳ Workflow ${executionId} still has pending steps`)
    }
    
    return false
  } catch (error) {
    Logger.error(`Failed to check workflow completion for ${executionId}: ${error}`)
    return false
  }
}

// Get workflow execution status (lightweight for polling)
export const GetWorkflowExecutionStatusApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const executionId = c.req.param("executionId")

    // Get only the status field for maximum performance
    const execution = await db
      .select({
        status: workflowExecution.status,
      })
      .from(workflowExecution)
      .where(and(
        eq(workflowExecution.workspaceId, user.workspaceId),
        eq(workflowExecution.userId, user.id),
        eq(workflowExecution.id, executionId),
      ))

    if (!execution || execution.length === 0) {
      throw new HTTPException(404, { message: "Workflow execution not found" })
    }

    return c.json({
      success: true,
      status: execution[0].status,
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow execution status")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get workflow execution
export const GetWorkflowExecutionApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const executionId = c.req.param("executionId")

    // Get execution directly by ID
    const execution = await db
      .select()
      .from(workflowExecution)
      .where(and(
        eq(workflowExecution.userId, user.id),
        eq(workflowExecution.workspaceId, user.workspaceId),
        eq(workflowExecution.id, executionId),
      ))

    if (!execution || execution.length === 0) {
      throw new HTTPException(404, { message: "Workflow execution not found" })
    }

    // Get step executions for this workflow
    const stepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    // Get all tool executions for this workflow with tool type
    const toolExecutions = await db
      .select({
        id: toolExecution.id,
        workflowToolId: toolExecution.workflowToolId,
        workflowExecutionId: toolExecution.workflowExecutionId,
        status: toolExecution.status,
        result: toolExecution.result,
        startedAt: toolExecution.startedAt,
        completedAt: toolExecution.completedAt,
        createdAt: toolExecution.createdAt,
        updatedAt: toolExecution.updatedAt,
        toolType: workflowTool.type,
      })
      .from(toolExecution)
      .leftJoin(workflowTool, eq(toolExecution.workflowToolId, workflowTool.id))
      .where(eq(toolExecution.workflowExecutionId, executionId))

    return c.json({
      success: true,
      data: {
        ...execution[0],
        stepExecutions: stepExecutions,
        toolExecutions: toolExecutions,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow execution")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Form submission with file upload integration
export const SubmitWorkflowFormApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const contentType = c.req.header("content-type") || ""
    let stepId: string
    let formData: any = {}
    let currentStepExecution: any = undefined

    if (contentType.includes("multipart/form-data")) {
      // Handle multipart form data (with file uploads) using handleAttachmentUpload
      console.log("Processing multipart form data...")
      const multipartData = await c.req.formData()
      stepId = multipartData.get("stepId") as string

      if (!stepId) {
        throw new HTTPException(400, { message: "stepId is required" })
      }

      // Extract form fields (non-file data)
      const entries: [string, FormDataEntryValue][] = []
      multipartData.forEach((value, key) => {
        entries.push([key, value])
      })
      for (const [key, value] of entries) {
        if (key !== "stepId" && typeof value === "string") {
          formData[key] = value
        }
      }

      // Get step execution to access workflow IDs for file handling
      const stepExecution = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.id, stepId))

      if (!stepExecution || stepExecution.length === 0) {
        throw new HTTPException(404, {
          message: "Workflow step execution not found",
        })
      }

      currentStepExecution = stepExecution[0]

      // Get step template to access form definition for validation
      const stepTemplate = await db
        .select()
        .from(workflowStepTemplate)
        .where(
          eq(
            workflowStepTemplate.id,
            currentStepExecution.workflowStepTemplateId,
          ),
        )

      if (!stepTemplate || stepTemplate.length === 0) {
        throw new HTTPException(404, { message: "Step template not found" })
      }

      const toolIds = stepTemplate[0].toolIds || []
      if (toolIds.length === 0) {
        throw new HTTPException(400, {
          message: "No tools configured for this step",
        })
      }

      const formTool = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolIds[0]))

      if (!formTool || formTool.length === 0) {
        throw new HTTPException(404, { message: "Form tool not found" })
      }

      const formDefinition = formTool[0].value as any
      const formFields = formDefinition?.fields || []

      // Build validation schema from form definition
      const validationSchema = buildValidationSchema(formFields)

      // Validate non-file form data (exclude file fields from initial validation)
      const nonFileData = { ...formData }
      const nonFileValidationSchema = { ...validationSchema }

      // Remove file fields from validation schema for initial check
      for (const field of formFields) {
        if (field.type === "file") {
          delete nonFileValidationSchema[field.id]
        }
      }

      const validationResult = validateFormData(
        nonFileData,
        nonFileValidationSchema,
      )

      if (!validationResult.isValid) {
        throw new HTTPException(400, {
          message: `Form validation failed: ${validationResult.errors.join(", ")}`,
        })
      }

      // Handle file uploads with new workflow file handler
      for (const field of formFields) {
        if (field.type === "file") {
          const files = multipartData.getAll(field.id) as File[]

          if (files.length > 0) {
            try {
              const file = files[0] // Use first file
              const fileValidation = validationSchema[field.id]?.fileValidation

              const uploadedFile = await handleWorkflowFileUpload(
                file,
                currentStepExecution.workflowExecutionId,
                currentStepExecution.id,
                fileValidation,
              )

              formData[field.id] = uploadedFile
              console.log(
                `File uploaded for field ${field.id}:`,
                uploadedFile.relativePath,
              )
            } catch (uploadError) {
              Logger.error(
                uploadError,
                `File upload failed for field ${field.id}`,
              )
              throw new HTTPException(400, {
                message: `File upload failed for ${field.id}: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
              })
            }
          } else if (field.required) {
            throw new HTTPException(400, {
              message: `Required file field '${field.id}' is missing`,
            })
          }
        }
      }
    } else {
      // Handle JSON form data
      const jsonData = await c.req.json()
      stepId = jsonData.stepId
      formData = jsonData.formData || {}
    }

    console.log(`Form submission for stepId: ${stepId}`)

    // Use the step execution and form tool we already fetched for multipart data
    let stepExecution =
      typeof currentStepExecution !== "undefined" ? currentStepExecution : null
    let formTool = null

    if (!stepExecution) {
      // Handle JSON case - fetch step execution
      const stepExecutions = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.id, stepId))

      if (!stepExecutions || stepExecutions.length === 0) {
        throw new HTTPException(404, {
          message: "Workflow step execution not found",
        })
      }

      stepExecution = stepExecutions[0]

      // Get the form tool for JSON case
      const stepTemplate = await db
        .select()
        .from(workflowStepTemplate)
        .where(
          eq(workflowStepTemplate.id, stepExecution.workflowStepTemplateId),
        )

      if (!stepTemplate || stepTemplate.length === 0) {
        throw new HTTPException(404, { message: "Step template not found" })
      }

      const toolIds = stepTemplate[0].toolIds || []
      if (toolIds.length === 0) {
        throw new HTTPException(400, {
          message: "No tools configured for this step",
        })
      }

      const formToolResult = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolIds[0]))

      if (!formToolResult || formToolResult.length === 0) {
        throw new HTTPException(404, { message: "Form tool not found" })
      }

      formTool = formToolResult[0]
    } else {
      // For multipart case, we already have the form tool fetched
      const stepTemplateForMultipart = await db
        .select()
        .from(workflowStepTemplate)
        .where(
          eq(workflowStepTemplate.id, stepExecution.workflowStepTemplateId),
        )

      if (stepTemplateForMultipart && stepTemplateForMultipart.length > 0) {
        const toolIds = stepTemplateForMultipart[0].toolIds || []
        if (toolIds.length > 0) {
          const formToolResult = await db
            .select()
            .from(workflowTool)
            .where(eq(workflowTool.id, toolIds[0]))

          if (formToolResult && formToolResult.length > 0) {
            formTool = formToolResult[0]
          }
        }
      }
    }

    // Create tool execution record for form submission
    console.log("Creating tool execution record...")

    if (!formTool) {
      throw new HTTPException(404, {
        message: "Form tool not found for submission",
      })
    }

    const [toolExecutionRecord] = await db
      .insert(toolExecution)
      .values({
        workflowToolId: formTool.id,
        workflowExecutionId: stepExecution.workflowExecutionId,
        status: WorkflowStatus.COMPLETED,
        result: {
          formData: formData,
          submittedAt: new Date().toISOString(),
          submittedBy: "demo",
        },
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning()

    console.log("Tool execution created successfully")

    // Update the step execution as completed
    console.log("Updating step execution...")
    await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: "demo",
        completedAt: new Date(),
        toolExecIds: [toolExecutionRecord.id],
        metadata: {
          ...stepExecution.metadata,
          formSubmission: {
            formData: formData,
            submittedAt: new Date().toISOString(),
            submittedBy: "demo",
          },
        },
      })
      .where(eq(workflowStepExecution.id, stepId))

    console.log("Step execution updated successfully")

    // Continue workflow execution - execute next automated steps
    const tools = await db
      .select()
      .from(workflowTool)
      .where(
        and(
          eq(workflowTool.workspaceId, user.workspaceId),
          eq(workflowTool.userId, user.id),
        ),
      )
    const stepName = stepExecution.name || "unknown_step"
    const currentResults: Record<string, any> = {}
    currentResults[stepName] = {
      stepId: stepExecution.id,
      formSubmission: {
        formData: formData,
        submittedAt: new Date().toISOString(),
        submittedBy: "demo",
      },
      toolExecution: toolExecutionRecord,
    }

    // Execute next steps if they are automated using UUID arrays
    if (stepExecution.nextStepIds && Array.isArray(stepExecution.nextStepIds)) {
      for (const nextStepTemplateId of stepExecution.nextStepIds) {
        const allSteps = await db
          .select()
          .from(workflowStepExecution)
          .where(
            eq(
              workflowStepExecution.workflowExecutionId,
              stepExecution.workflowExecutionId,
            ),
          )

        const nextStep = allSteps.find(
          (s) => s.workflowStepTemplateId === nextStepTemplateId,
        )

        if (nextStep && nextStep.type === StepType.AUTOMATED) {
          await executeWorkflowChain(
            stepExecution.workflowExecutionId,
            nextStep.id,
            tools,
            currentResults,
          )
        }
      }
    }

    return c.json({
      success: true,
      message: "Form submitted and workflow continued",
      data: {
        stepId: stepId,
        toolExecution: toolExecutionRecord,
        formData: formData,
        nextStepsTriggered: stepExecution.nextStepIds?.length || 0,
      },
    })
  } catch (error) {
    Logger.error(error, "Form submission failed")

    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Helper function to generate cURL command from webhook data
const generateCurlCommand = (webhookData: {
  method: string
  url: string
  headers: Record<string, any>
  body: any
}): string => {
  try {
    let curl = `curl -X ${webhookData.method.toUpperCase()}`
    
    // Add headers
    Object.entries(webhookData.headers || {}).forEach(([key, value]) => {
      if (value) {
        curl += ` -H "${key}: ${value}"`
      }
    })
    
    // Add body for POST/PUT/PATCH requests
    if (webhookData.body && ["POST", "PUT", "PATCH"].includes(webhookData.method.toUpperCase())) {
      const bodyStr = typeof webhookData.body === 'string' 
        ? webhookData.body 
        : JSON.stringify(webhookData.body)
      curl += ` -d '${bodyStr}'`
    }
    
    // Add URL (should be last)
    curl += ` "${webhookData.url}"`
    
    return curl
  } catch (error) {
    return `curl -X ${webhookData.method.toUpperCase()} "${webhookData.url}"`
  }
}

// Helper function to extract content from previous step results using simplified input paths
// Workflow-Todo: This function can be enhanced to support more complex path syntaxes if needed, currently this 
const extractContentFromPath = (
  previousStepResults: any,
  contentPath: string,
): string => {
  try {

    if (!contentPath.startsWith("input.")) {
      return `Invalid path: ${contentPath}. Only paths starting with 'input.' are supported.`
    }

    // Get all step keys
    const stepKeys = Object.keys(previousStepResults)
    if (stepKeys.length === 0) {
      return "No previous steps available"
    }

    const propertyPath = contentPath.slice(6) // Remove "input."
    const pathParts = propertyPath.split(".")


    const latestStepKey = stepKeys[stepKeys.length - 1]
    const latestStepResult = previousStepResults[latestStepKey]

    if (latestStepResult?.result) {
      let target = latestStepResult.result

      // Navigate through the path starting from result
      for (const part of pathParts) {
        if (target && typeof target === "object" && part in target) {
          target = target[part]
        } else {
          Logger.debug(`DEBUG - extractContentFromPath: Property '${part}' not found in latest step result`)
          return `Property '${part}' not found in any step result. Available steps: ${stepKeys.join(", ")}`
        }
      }

      // Convert result to string
      if (typeof target === "string") {
        return target
      } else if (target !== null && target !== undefined) {
        return JSON.stringify(target, null, 2)
      }
    }

    return `No content found for path '${contentPath}' in any step. Available steps: ${stepKeys.join(", ")}`
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`
  }
}

// Helper function to get execution context (user info) from workflow execution
//Workflow-Todo : after DB Changes we might not need this function as we can fetch userId and workspaceId directly from workflowExecution table
const getExecutionContext = async (executionId: string): Promise<{
  workspaceId: string
  userEmail: string
  workspaceInternalId: string
  userId: string
} | null> => {
  try {
    // Get workflow execution to access metadata
    const [execution] = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

    if (!execution) {
      Logger.warn(`No execution found for execution ${executionId}`)
      return null
    }

    // Check if execution context was stored in metadata (for manual executions)
    const context = execution.metadata as any
    if (context && context.executionContext) {
      Logger.info(`✅ Found execution context in metadata for ${executionId}`)
      return context.executionContext
    }

    // For webhook-triggered executions, get user info from execution record
    if (execution.userId && execution.workspaceId) {
      Logger.info(`🔄 Getting execution context from user/workspace IDs for webhook execution ${executionId}`)
      
      // Import user module to get user details
      const { users, workspaces } = await import("@/db/schema")
      
      // Get user details
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, execution.userId))
        .limit(1)
      
      // Get workspace details  
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, execution.workspaceId))
        .limit(1)
      
      if (user && workspace) {
        const executionContext = {
          workspaceId: workspace.externalId || workspace.id.toString(),
          userEmail: user.email,
          workspaceInternalId: workspace.id.toString(),
          userId: user.id.toString()
        }
        
        Logger.info(`✅ Created execution context for webhook execution:`, {
          userEmail: executionContext.userEmail,
          workspaceId: executionContext.workspaceId,
          userId: executionContext.userId
        })
        
        return executionContext
      } else {
        Logger.warn(`❌ Could not find user (${execution.userId}) or workspace (${execution.workspaceId}) for execution ${executionId}`)
      }
    }

    Logger.warn(`❌ No execution context available for execution ${executionId}`)
    return null
  } catch (error) {
    Logger.error(error, `Failed to get execution context for ${executionId}`)
    return null
  }
}

// Execute workflow tool (Python scripts, etc.)
const executeWorkflowTool = async (
  tool: any,
  previousStepResults: any = {},
  executionId: string,
) => {
  try {
    switch (tool.type) {
      case "form":
        // Form tools are handled by form submission API
        return {
          status: "awaiting_user_input",
          result: {
            formDefinition: tool.value,
            message: "User input required - handled by form submission API",
          },
        }


      case "email":
        // Enhanced email tool using config for recipients and configurable path for content extraction
        const emailConfig = tool.config || {}
        const toEmail = emailConfig.to_email || emailConfig.recipients || []
        const fromEmail = emailConfig.from_email || "no-reply@xyne.io"

        const contentType = emailConfig.content_type || "html"
        const [execution] = await db
          .select()
          .from(workflowExecution)
          .where(eq(workflowExecution.id, executionId))

        const workflowName = execution?.name || "Unknown Workflow"
        const subject = emailConfig.subject || `Results of Workflow: ${workflowName}`
        // New configurable content path feature
        const contentPath =
          emailConfig.content_path || emailConfig.content_source_path

        try {
          let emailBody = ""

          if (contentPath) {
            // Extract content using configurable path
            emailBody = extractContentFromPath(previousStepResults, contentPath)

            if (!emailBody) {
              emailBody = `No content found at path: ${contentPath}`
            }
          } else {
            // Try multiple standard paths for email content
            emailBody = extractContentFromPath(previousStepResults, "input.aiOutput") ||
                       extractContentFromPath(previousStepResults, "input.content") ||
                       extractContentFromPath(previousStepResults, "input.output")
            
            if (!emailBody || emailBody.includes("not found")) {
              // Try direct path access for different types of previous step data
              const stepKeys = Object.keys(previousStepResults)
              if (stepKeys.length > 0) {
                // Look for AI Agent output first (most recent step is usually what we want)
                for (let i = stepKeys.length - 1; i >= 0; i--) {
                  const stepKey = stepKeys[i]
                  const stepData = previousStepResults[stepKey]
                  
                  // Try AI Agent output first
                  if (stepData?.result?.aiOutput) {
                    emailBody = stepData.result.aiOutput
                    Logger.info(`📧 Email using AI Agent output from step: ${stepKey}`)
                    break
                  }
                  
                  // Try standard content fields
                  if (stepData?.result?.content || stepData?.result?.output) {
                    emailBody = stepData.result.content || stepData.result.output
                    Logger.info(`📧 Email using content/output from step: ${stepKey}`)
                    break
                  }
                  
                  // Handle HTTP node output
                  if (stepData?.toolType === 'http_request' && stepData?.result?.data) {
                    const httpResult = stepData.result
                    emailBody = `HTTP Request Summary:
URL: ${httpResult.url}
Method: ${httpResult.method}
Status: ${httpResult.statusCode} ${httpResult.statusText}
Success: ${httpResult.success}

Response Data:
${JSON.stringify(httpResult.data, null, 2)}`
                    Logger.info(`📧 Email using HTTP node output from step: ${stepKey}`)
                    break
                  }
                }
                
                // Fallback if no suitable content found
                if (!emailBody) {
                  emailBody = "No suitable content found from previous steps"
                  Logger.warn(`📧 Email fallback: No content found in ${stepKeys.length} previous steps`)
                }
              } else {
                emailBody = "No previous steps available"
                Logger.warn(`📧 Email fallback: No previous step results available`)
              }
            }
          }

          // Wrap plain text in HTML if content type is HTML
          if (contentType === "html" && !emailBody.includes("<html")) {
            emailBody = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: 'Segoe UI', sans-serif; line-height: 1.6; margin: 20px; }
        .content { max-width: 800px; margin: 0 auto; }
        .header { background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .body-content { background: white; padding: 20px; border: 1px solid #dee2e6; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="content">
        <div class="header">
            <h2>🤖 Results of Workflow: ${workflowName} </h2>
            <p>Generated on: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}</p>
        </div>
        <div class="body-content">
            ${emailBody.replace(/\n/g, "<br>")}
        </div>
    </div>
</body>
</html>`
          }

          // Validate email configuration
          if (!toEmail || (Array.isArray(toEmail) && toEmail.length === 0)) {
            return {
              status: "error",
              result: {
                error:
                  "No email recipients configured in tool config (to_email or recipients field required)",
                config: emailConfig,
              },
            }
          }

          // Import and use the email service
          const { emailService } = await import("@/services/emailService")

          // Convert single email to array if needed
          const recipients = Array.isArray(toEmail) ? toEmail : [toEmail]

          // Send email to all recipients
          const emailResults = []
          for (const recipient of recipients) {
            try {
              const emailSent = await emailService.sendEmail({
                to: recipient,
                subject,
                body: emailBody,
                contentType: contentType === "html" ? "html" : "text",
              })
              emailResults.push({ recipient, sent: emailSent })
            } catch (emailError) {
              emailResults.push({
                recipient,
                sent: false,
                error:
                  emailError instanceof Error
                    ? emailError.message
                    : String(emailError),
              })
            }
          }

          const successCount = emailResults.filter((r) => r.sent).length
          const allSent = successCount === recipients.length

          return {
            status: allSent ? "success" : "partial_success",
            result: {
              emails_sent: successCount,
              total_recipients: recipients.length,
              all_sent: allSent,
              results: emailResults,
              email_details: {
                from: fromEmail,
                subject,
                content_type: contentType,
                body_length: emailBody.length,
              },
              message: allSent
                ? `Email sent successfully to all ${successCount} recipients`
                : `Email sent to ${successCount} of ${recipients.length} recipients`,
            },
          }
        } catch (error) {
          return {
            status: "error",
            result: {
              error: "Email tool execution failed",
              message: error instanceof Error ? error.message : String(error),
              config: emailConfig,
            },
          }
        }

      case "ai_agent":
        const aiConfig = tool.config || {}
        const aiValue = tool.value || {}
        const agentId = aiConfig.agentId


        if (!agentId) {
          Logger.error("No agent ID found in tool config - agent creation may have failed during template creation")
          return {
            status: "error",
            result: {
              error: "No agent ID configured for this AI agent tool",
              details: "Agent should have been created during workflow template creation",
              config: aiConfig
            }
          }
        }

        try {
          // Get execution context for user infon
          const executionContext = await getExecutionContext(executionId)
          if (!executionContext) {
            return {
              status: "error",
              result: {
                error: "Could not retrieve execution context",
                details: "User information not available for agent execution"
              }
            }
          }

          // Extract agent parameters with dynamic values
          const prompt = aiValue.prompt || aiValue.systemPrompt || "Please analyze the provided content"
          const temperature = aiConfig.temperature || 0.7
          const workspaceId = executionContext.workspaceId
          const userEmail = executionContext.userEmail

          // Generic AI Agent input processing - handles all input types
          let userQuery = ""
          let imageAttachmentIds: string[] = []
          let documentAttachmentIds: string[] = []

          Logger.info(`🔄 AI Agent processing input for execution ${executionId}:`, {
            inputType: aiConfig.inputType,
            prompt: prompt.substring(0, 100) + "...",
            previousStepsCount: Object.keys(previousStepResults).length,
            previousStepsKeys: Object.keys(previousStepResults)
          })

          // Process all previous steps to extract content and attachments
          const stepKeys = Object.keys(previousStepResults)
          let content = ""
          let hasProcessedContent = false

          if (stepKeys.length > 0) {
            // Process each step to extract content and attachments
            for (let i = stepKeys.length - 1; i >= 0; i--) {
              const stepKey = stepKeys[i]
              const stepData = previousStepResults[stepKey]
              
              Logger.info(`📊 Processing step ${i + 1}/${stepKeys.length}: ${stepKey}`, {
                toolType: stepData?.toolType,
                hasResult: !!stepData?.result,
                resultKeys: stepData?.result ? Object.keys(stepData.result) : []
              })

              // Extract attachments from any step (form, file uploads, direct attachments, etc.)
              
              // Method 1: Form data attachments
              if (stepData?.result?.formData || stepData?.formSubmission?.formData) {
                const formData = stepData.result?.formData || stepData.formSubmission?.formData || {}
                const extractedIds = extractAttachmentIds(formData)
                imageAttachmentIds.push(...extractedIds.imageAttachmentIds)
                documentAttachmentIds.push(...extractedIds.documentAttachmentIds)
                
                Logger.info(`📎 Extracted form attachments from ${stepKey}:`, {
                  images: extractedIds.imageAttachmentIds.length,
                  documents: extractedIds.documentAttachmentIds.length
                })
              }
              
              // Method 2: Direct attachment arrays
              if (stepData?.result?.attachments) {
                const attachments = Array.isArray(stepData.result.attachments) 
                  ? stepData.result.attachments 
                  : [stepData.result.attachments]
                
                attachments.forEach((attachment: any) => {
                  if (attachment?.attachmentId) {
                    if (attachment.attachmentMetadata?.isImage) {
                      imageAttachmentIds.push(attachment.attachmentId)
                    } else {
                      documentAttachmentIds.push(attachment.attachmentId)
                    }
                  }
                })
                
                Logger.info(`📎 Extracted direct attachments from ${stepKey}: ${attachments.length}`)
              }
              
              // Method 3: File IDs arrays (common format)
              if (stepData?.result?.fileIds && Array.isArray(stepData.result.fileIds)) {
                documentAttachmentIds.push(...stepData.result.fileIds)
                Logger.info(`📎 Extracted file IDs from ${stepKey}: ${stepData.result.fileIds.length}`)
              }
              
              // Method 4: Image/document specific arrays
              if (stepData?.result?.imageAttachmentIds && Array.isArray(stepData.result.imageAttachmentIds)) {
                imageAttachmentIds.push(...stepData.result.imageAttachmentIds)
              }
              if (stepData?.result?.documentAttachmentIds && Array.isArray(stepData.result.documentAttachmentIds)) {
                documentAttachmentIds.push(...stepData.result.documentAttachmentIds)
              }

              // Extract content only from the most recent relevant step
              if (!hasProcessedContent) {
                // Priority 1: Direct AI/content output
                if (stepData?.result?.aiOutput) {
                  content = stepData.result.aiOutput
                  Logger.info(`🤖 Using AI output from step: ${stepKey}`)
                  hasProcessedContent = true
                } else if (stepData?.result?.content || stepData?.result?.output) {
                  content = stepData.result.content || stepData.result.output
                  Logger.info(`📄 Using content/output from step: ${stepKey}`)
                  hasProcessedContent = true
                } 
                // Priority 2: HTTP node data
                else if (stepData?.toolType === 'http_request' && stepData?.result?.data) {
                  const httpData = stepData.result
                  content = `HTTP Request Results:
- URL: ${httpData.url || 'N/A'}
- Method: ${httpData.method || 'N/A'}
- Status: ${httpData.statusCode} ${httpData.statusText || ''}
- Success: ${httpData.success || false}
- Duration: ${httpData.duration || 0}ms
- Content Type: ${httpData.contentType || 'N/A'}

Response Data:
${JSON.stringify(httpData.data, null, 2)}

Raw Response Preview:
${(httpData.rawResponse || '').substring(0, 1000)}${httpData.rawResponse?.length > 1000 ? '...' : ''}

Response Headers:
${JSON.stringify(httpData.headers || {}, null, 2)}`
                  
                  Logger.info(`🌐 Using HTTP response from step: ${stepKey}`, {
                    url: httpData.url,
                    status: httpData.statusCode,
                    dataType: typeof httpData.data,
                    dataSize: JSON.stringify(httpData.data || {}).length
                  })
                  hasProcessedContent = true
                }
                // Priority 3: Webhook data
                else if (stepData?.toolType === 'webhook' || stepData?.result?.webhook) {
                  const webhookData = stepData.result?.webhook || stepData.result
                  content = `Webhook Request Details:
- Method: ${webhookData.method || 'N/A'}
- URL: ${webhookData.url || 'N/A'}
- Path: ${webhookData.path || 'N/A'}
- Timestamp: ${webhookData.timestamp || 'N/A'}

Headers:
${JSON.stringify(webhookData.headers || {}, null, 2)}

Query Parameters:
${JSON.stringify(webhookData.query || {}, null, 2)}

Request Body:
${JSON.stringify(webhookData.body || {}, null, 2)}`
                  
                  Logger.info(`📡 Using webhook data from step: ${stepKey}`)
                  hasProcessedContent = true
                }
                // Priority 4: Form data text fields
                else if (stepData?.result?.formData || stepData?.formSubmission?.formData) {
                  const formData = stepData.result?.formData || stepData.formSubmission?.formData || {}
                  const textFields = Object.entries(formData)
                    .filter(([, value]) => typeof value === "string" && value.trim())
                    .map(([key, value]) => `${key}: ${value}`)
                    .join("\n")
                  
                  if (textFields) {
                    content = `Form Data:\n${textFields}`
                    Logger.info(`📝 Using form text data from step: ${stepKey}`)
                    hasProcessedContent = true
                  }
                }
                // Priority 5: Raw data fallback
                else if (stepData?.result && Object.keys(stepData.result).length > 0) {
                  content = `Data from ${stepKey} (${stepData.toolType || 'unknown'} tool):
${JSON.stringify(stepData.result, null, 2)}`
                  Logger.info(`🔍 Using raw data from step: ${stepKey}`)
                  hasProcessedContent = true
                }
              }
            }

            // Remove duplicate attachment IDs
            imageAttachmentIds = [...new Set(imageAttachmentIds)]
            documentAttachmentIds = [...new Set(documentAttachmentIds)]

            Logger.info(`📎 Total attachments collected:`, {
              images: imageAttachmentIds.length,
              documents: documentAttachmentIds.length,
              imageIds: imageAttachmentIds,
              documentIds: documentAttachmentIds
            })
          }

          // Build the final user query
          if (content || imageAttachmentIds.length > 0 || documentAttachmentIds.length > 0) {
            let queryParts = [prompt]
            
            if (content) {
              queryParts.push(`\nContent to analyze:\n${content}`)
            }
            
            if (imageAttachmentIds.length > 0) {
              queryParts.push(`\nImage attachments: ${imageAttachmentIds.length} file(s)`)
            }
            
            if (documentAttachmentIds.length > 0) {
              queryParts.push(`\nDocument attachments: ${documentAttachmentIds.length} file(s)`)
            }
            
            userQuery = queryParts.join("")
          } else {
            userQuery = prompt
            Logger.info(`📝 AI Agent using only prompt - no previous step data found`)
          }

          Logger.info(`🤖 AI Agent final query prepared:`, {
            promptLength: prompt.length,
            contentLength: content.length,
            queryLength: userQuery.length,
            hasImages: imageAttachmentIds.length > 0,
            hasDocuments: documentAttachmentIds.length > 0,
            contentPreview: content.substring(0, 200) + (content.length > 200 ? "..." : "")
          })
          const isExistingAgent = aiConfig.isExistingAgent
          Logger.info(`Executing agent ${agentId} (existing: ${isExistingAgent}) for user ${userEmail} in workspace ${workspaceId}`)

          const fullResult = await executeAgentForWorkflowWithRag({
            agentId,
            userQuery,
            userEmail,
            workspaceId,
            isStreamable: false,
            temperature,
            attachmentFileIds: imageAttachmentIds,
            nonImageAttachmentFileIds: documentAttachmentIds,
          })

          if (!fullResult.success) {
            Logger.error(`🚨 AI Agent execution failed:`, {
              error: fullResult.error,
              agentId: agentId,
              executionId: executionId
            })
            return {
              status: "error",
              result: {
                error: "Agent execution failed",
                details: fullResult.error,
              }
            }
          }

          Logger.info(`✅ AI Agent execution successful:`, {
            responseLength: fullResult.response?.length || 0,
            responsePreview: fullResult.response?.substring(0, 100) + "...",
            agentId: agentId,
            executionId: executionId
          })

          return {
            status: "success",
            result: {
              aiOutput: fullResult.response,
              agentName: aiConfig.agentName || "Unknown Agent",
              model: aiConfig.modelId || "gpt-4o",
              inputType: aiConfig.inputType || "text",
              processedAt: new Date().toISOString(),
              chatId: null
            }
          }
        } catch (error) {
          Logger.error(error, "ExecuteAgentForWorkflow failed in workflow")
          return {
            status: "error",
            result: {
              error: "Agent execution failed",
              message: error instanceof Error ? error.message : String(error),
              inputType: aiConfig.inputType,
            }
          }
        }

      case "http_request":
        try {
          const httpConfig = tool.config || {}
          const httpValue = tool.value || {}
          
          // Extract configuration from both config and value objects
          const url = httpValue.url || httpConfig.url
          const method = (httpValue.method || httpConfig.method || "GET").toUpperCase()
          const headers = { ...httpConfig.headers, ...httpValue.headers }
          const queryParams = { ...httpConfig.queryParams, ...httpValue.queryParams }
          const body = httpValue.body || httpConfig.body
          const bodyType = httpValue.bodyType || httpConfig.bodyType || "json"
          const authentication = httpConfig.authentication || httpValue.authentication || "none"
          const authConfig = httpConfig.authConfig || httpValue.authConfig || {}
          const timeout = httpConfig.timeout || httpValue.timeout || 30000

          // Validate required fields
          if (!url) {
            return {
              status: "error",
              result: {
                error: "URL is required for HTTP request",
                config: { httpConfig, httpValue }
              }
            }
          }

          // Validate URL format
          try {
            new URL(url)
          } catch (urlError) {
            return {
              status: "error",
              result: {
                error: "Invalid URL format",
                url: url,
                details: urlError instanceof Error ? urlError.message : String(urlError)
              }
            }
          }

          Logger.info(`🌐 Making HTTP ${method} request to: ${url}`)

          // Build the final URL with query parameters
          const finalUrl = new URL(url)
          if (queryParams) {
            Object.entries(queryParams).forEach(([key, value]) => {
              if (value) {
                finalUrl.searchParams.append(key, String(value))
              }
            })
          }

          // Build request headers
          const requestHeaders: Record<string, string> = {
            'User-Agent': 'Xyne-Workflow/1.0'
          }

          // Add custom headers
          if (headers) {
            Object.assign(requestHeaders, headers)
          }

          // Handle authentication
          if (authentication === "basic" && authConfig?.username && authConfig?.password) {
            const credentials = btoa(`${authConfig.username}:${authConfig.password}`)
            requestHeaders['Authorization'] = `Basic ${credentials}`
          } else if (authentication === "bearer" && authConfig?.token) {
            requestHeaders['Authorization'] = `Bearer ${authConfig.token}`
          } else if (authentication === "api_key" && authConfig?.apiKey && authConfig?.apiKeyHeader) {
            requestHeaders[authConfig.apiKeyHeader] = authConfig.apiKey
          }

          // Prepare request body for POST/PUT/PATCH
          let requestBody: string | undefined
          if (body && ["POST", "PUT", "PATCH"].includes(method)) {
            if (bodyType === "json") {
              requestHeaders['Content-Type'] = 'application/json'
              requestBody = typeof body === 'string' ? body : JSON.stringify(body)
            } else if (bodyType === "form") {
              requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
              requestBody = body
            } else {
              requestBody = body
            }
          }

          Logger.info(`📤 Request details:`, {
            finalUrl: finalUrl.toString(),
            method,
            hasBody: !!requestBody,
            bodyLength: requestBody?.length || 0,
            headerCount: Object.keys(requestHeaders).length
          })

          // Make the HTTP request
          try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), timeout)

            const startTime = Date.now()
            
            const response = await fetch(finalUrl.toString(), {
              method,
              headers: requestHeaders,
              body: requestBody,
              signal: controller.signal
            })

            clearTimeout(timeoutId)
            const duration = Date.now() - startTime

            Logger.info(`📥 Response received: ${response.status} ${response.statusText} (${duration}ms)`)

            // Read response body
            let responseText = ""
            let responseData: any = null
            
            try {
              responseText = await response.text()
              const contentType = response.headers.get('content-type') || ''
              
              // Try to parse as JSON if appropriate
              if (contentType.includes('application/json') && responseText) {
                try {
                  responseData = JSON.parse(responseText)
                } catch {
                  responseData = responseText
                }
              } else {
                responseData = responseText
              }
            } catch (bodyError) {
              Logger.warn(`Failed to read response body: ${bodyError}`)
              responseData = "Failed to read response body"
            }

            // Collect response headers
            const responseHeaders: Record<string, string> = {}
            response.headers.forEach((value, key) => {
              responseHeaders[key] = value
            })

            const isSuccess = response.status >= 200 && response.status < 300

            Logger.info(`✅ Request completed successfully: ${response.status}`)

            return {
              status: isSuccess ? "success" : "partial_success", // Even error responses contain useful data
              result: {
                statusCode: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
                data: responseData,
                rawResponse: responseText,
                url: finalUrl.toString(),
                method: method,
                duration: duration,
                success: isSuccess,
                contentType: response.headers.get('content-type') || '',
                timestamp: new Date().toISOString()
              }
            }

          } catch (fetchError) {
            Logger.error(`❌ HTTP request failed:`, fetchError)

            let errorMessage = "Request failed"
            let troubleshooting = "Check URL and network connectivity"

            if (fetchError instanceof Error) {
              if (fetchError.name === 'AbortError') {
                errorMessage = `Request timed out after ${timeout}ms`
                troubleshooting = "Increase timeout or check if service is responding"
              } else {
                errorMessage = fetchError.message
                troubleshooting = "Verify URL is correct and accessible"
              }
            }

            return {
              status: "error",
              result: {
                error: "HTTP request failed",
                message: errorMessage,
                troubleshooting: troubleshooting,
                url: finalUrl.toString(),
                method: method,
                timestamp: new Date().toISOString(),
                debug: {
                  timeout: timeout,
                  originalError: fetchError instanceof Error ? fetchError.message : String(fetchError)
                }
              }
            }
          }

        } catch (error) {
          Logger.error(error, "HTTP request tool execution failed")
          return {
            status: "error",
            result: {
              error: "HTTP request tool execution failed",
              message: error instanceof Error ? error.message : String(error),
              config: tool.config,
              value: tool.value
            }
          }
        }

      case "webhook":
        try {
          Logger.info(`🚀 Executing webhook tool for execution ${executionId}`)
          
          // Get webhook execution data from the execution metadata
          const [execution] = await db
            .select()
            .from(workflowExecution)
            .where(eq(workflowExecution.id, executionId))
            .limit(1)

          if (!execution || !execution.metadata) {
            return {
              status: "error",
              result: {
                error: "No webhook execution data found",
                executionId: executionId
              }
            }
          }

          const webhookMetadata = execution.metadata as any
          const webhookData = webhookMetadata.webhook || webhookMetadata
          
          Logger.info(`📡 Webhook metadata found:`, { 
            hasMetadata: !!execution.metadata,
            hasWebhookData: !!webhookData,
            triggerType: webhookMetadata.triggerType,
            method: webhookData.method,
            path: webhookData.path 
          })
          
          // Extract webhook request data for output
          const webhookOutput = {
            method: webhookData.method || "POST",
            url: webhookData.url || `http://localhost:3000${webhookData.path || "/workflow/webhook"}`,
            path: webhookData.path || "/workflow/webhook",
            headers: webhookData.headers || {},
            query: webhookData.query || {},
            body: webhookData.body || webhookData.requestData || {},
            timestamp: webhookData.timestamp || new Date().toISOString(),
            // Add full request data for advanced use cases
            requestData: webhookData.requestData || webhookData.body || {},
            // Generate cURL command for easy sharing/debugging
            curl: generateCurlCommand({
              method: webhookData.method || "POST",
              url: webhookData.url || `http://localhost:3000${webhookData.path || "/workflow/webhook"}`,
              headers: webhookData.headers || {},
              body: webhookData.body || webhookData.requestData || {}
            }),
            // Add formatted summary for AI analysis
            summary: `Webhook received: ${webhookData.method || "POST"} request to ${webhookData.path || "/workflow/webhook"}`,
            // Add formatted content for email
            content: `Webhook Details:
- Method: ${webhookData.method || "POST"}
- Path: ${webhookData.path || "/workflow/webhook"}
- Timestamp: ${webhookData.timestamp || new Date().toISOString()}
- Headers: ${JSON.stringify(webhookData.headers || {}, null, 2)}
- Query: ${JSON.stringify(webhookData.query || {}, null, 2)}
- Body: ${JSON.stringify(webhookData.body || {}, null, 2)}`,
            // Add specific fields that other tools might need
            aiOutput: `Analyze this webhook request:\n${JSON.stringify(webhookData, null, 2)}`,
            output: `Webhook ${webhookData.method || "POST"} ${webhookData.path || "/workflow/webhook"} - ${new Date().toISOString()}`
          }

          Logger.info(`✅ Webhook tool processed successfully - method: ${webhookOutput.method}, path: ${webhookOutput.path}`)
          Logger.info(`📤 Webhook output data:`, { 
            hasUrl: !!webhookOutput.url,
            hasBody: !!webhookOutput.body,
            hasHeaders: Object.keys(webhookOutput.headers).length > 0,
            hasCurl: !!webhookOutput.curl
          })

          // Create formatted content for AI Agent analysis
          const formattedContent = `Webhook Request Analysis:

Method: ${webhookOutput.method}
URL: ${webhookOutput.url}  
Path: ${webhookOutput.path}
Timestamp: ${webhookOutput.timestamp}

Headers:
${JSON.stringify(webhookOutput.headers, null, 2)}

Query Parameters:
${JSON.stringify(webhookOutput.query, null, 2)}

Request Body:
${JSON.stringify(webhookOutput.body, null, 2)}

cURL Command:
${webhookOutput.curl}

Please analyze this webhook request and provide insights.`

          return {
            status: "success",
            result: {
              // Primary webhook data
              webhook: webhookOutput,
              // AI Agent expects content at these paths
              aiOutput: formattedContent,
              content: formattedContent,
              output: formattedContent,
              // Email tool expects content here
              input: {
                aiOutput: formattedContent,
                content: formattedContent,
                summary: `Webhook received: ${webhookOutput.method} request to ${webhookOutput.path}`,
                data: webhookOutput
              },
              // Raw data for advanced usage
              data: webhookOutput,
              // Status info
              success: true,
              message: `Webhook triggered: ${webhookOutput.method} ${webhookOutput.path}`,
              timestamp: webhookOutput.timestamp,
              // Curl info for HTTP Request tool if needed
              curlCommand: webhookOutput.curl
            }
          }

        } catch (error) {
          Logger.error(error, "Error processing webhook tool")
          return {
            status: "error",
            result: {
              error: "Failed to process webhook data",
              details: error instanceof Error ? error.message : String(error)
            }
          }
        }

      default:
        return {
          status: "error",
          result: {
            error: `Tool type '${tool.type}' not implemented`,
          },
        }
    }
  } catch (error) {
    return {
      status: "error",
      result: {
        error: "Tool execution failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

// List workflow tools
export const ListWorkflowToolsApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const tools = await db
      .select()
      .from(workflowTool)
      .where(
        and(
          eq(workflowTool.workspaceId, user.workspaceId),
          eq(workflowTool.userId, user.id),
        ),
      )
    return c.json({
      success: true,
      data: tools,
    })
  } catch (error) {
    Logger.error(error, "Failed to list workflow tools")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Additional API functions required by server.ts

// Create workflow template
export const CreateWorkflowTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(
      db,
      c.get(JwtPayloadKey)
    )
    const requestData = await c.req.json()

    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name: requestData.name,
        userId: user.id,
        workspaceId: user.workspaceId,
        isPublic: requestData.isPublic,
        description: requestData.description,
        version: requestData.version || "1.0.0",
        status: "draft",
        config: requestData.config || {},
      })
      .returning()

    return c.json({
      success: true,
      data: template,
    })
  } catch (error) {
    Logger.error(error, "Failed to create workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Create complex workflow template from frontend workflow builder
export const CreateComplexWorkflowTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(
      db,
      c.get(JwtPayloadKey)
    )


    let jwtPayload
    try {
      jwtPayload = c.get(JwtPayloadKey)
    } catch (e) {
      Logger.info("No JWT payload found in context")
    }

    const userEmail = jwtPayload?.sub
    if (!userEmail) {
      throw new HTTPException(400, { message: "Could not get the email of the user" })
    }

    // Get workspace ID from JWT payload
    const workspaceId = jwtPayload?.workspaceId
    if (!workspaceId) {
      throw new HTTPException(400, { message: "No workspace ID in token" })
    }

    // Get user ID for agent creation
    const userId = user.id

    const requestData = await c.req.json()

    // Create the main workflow template
    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name: requestData.name,
        userId: user.id,
        workspaceId: user.workspaceId,
        description: requestData.description,
        isPublic: requestData.isPublic,
        version: requestData.version || "1.0.0",
        status: "draft",
        config: requestData.config || {},
      })
      .returning()

    const templateId = template.id

    // Create workflow tools first (needed for step tool references)
    const toolIdMap = new Map<string, string>() // frontend tool ID -> backend tool ID
    const createdTools: any[] = []

    // Collect all tools from nodes
    const allTools = requestData.nodes
      .flatMap((node: any) => node.data?.tools || [])
      .filter((tool: any) => tool && tool.type)

    // Create unique tools (deduplicate by frontend tool ID if it exists)
    const uniqueTools = allTools.reduce((acc: any[], tool: any) => {
      // If tool has an ID and we haven't seen it, add it
      if (tool.id && !acc.find(t => t.id === tool.id)) {
        acc.push(tool)
      } else if (!tool.id) {
        // If tool has no ID, always add it (will get new ID)
        acc.push(tool)
      }
      return acc
    }, [])

    for (const tool of uniqueTools) {
      // Process form tools to ensure file fields use "document_file" as ID
      let processedValue = tool.value || {}


      if (tool.type === ToolType.FORM && processedValue.fields && Array.isArray(processedValue.fields)) {
        processedValue = {
          ...processedValue,
          fields: processedValue.fields.map((field: any) => {
            if (field.type === "file") {
              return {
                ...field,
                id: "document_file"
              }
            }
            return field
          })
        }
      }

      // Process AI agent tools to add inputType: "form" in config
      let processedConfig = tool.config || {}

      if (tool.type === "ai_agent") {
        try {
          Logger.info(`Processing AI agent tool: ${JSON.stringify(tool.value)}`)

          // Check if this is referencing an existing agent
          if (tool.value?.isExistingAgent && tool.value?.agentId) {
            // Reference existing agent - don't create new one
            Logger.info(`Referencing existing agent: ${tool.value.agentId}`)

            processedConfig = {
              ...processedConfig,
              inputType: "form",
              agentId: tool.value.agentId,
              agentName: tool.value.name,
              isExistingAgent: true,
              dynamicallyCreated: false
            }

            Logger.info(`Tool config updated with existing agent ID: ${tool.value.agentId}`)

          } else {
            // Create new agent for workflow (existing behavior)
            Logger.info(`Creating new agent for workflow`)

            const agentData: CreateAgentPayload = {
              name: tool.value?.name || `Workflow Agent - ${template.name}`,
              description: tool.value?.description || "Auto-generated agent for workflow execution",
              prompt: tool.value?.systemPrompt || "You are a helpful assistant that processes workflow data.",
              model: tool.value?.model || "googleai-gemini-2-5-flash",
              isPublic: false,
              appIntegrations: [],
              allowWebSearch: false,
              isRagOn: false,
              uploadedFileNames: [],
              docIds: [],
              userEmails: []
            }

            Logger.info(`Creating agent with data: ${JSON.stringify(agentData)}`)

            // Create the agent using createAgentForWorkflow
            const newAgent: SelectAgent = await createAgentForWorkflow(agentData, userId, user.workspaceId)

            Logger.info(`Successfully created agent: ${newAgent.externalId} for workflow tool`)

            processedConfig = {
              ...processedConfig,
              inputType: "form",
              agentId: newAgent.externalId,
              createdAgentId: newAgent.externalId,
              agentName: newAgent.name,
              isExistingAgent: false,
              dynamicallyCreated: true
            }

            Logger.info(`Tool config updated with agent ID: ${newAgent.externalId}`)
          }

        } catch (agentCreationError) {
          Logger.error(agentCreationError, `Failed to process agent for workflow tool`)

          processedConfig = {
            ...processedConfig,
            inputType: "form",
            agentCreationFailed: true,
            agentCreationError: agentCreationError instanceof Error ? agentCreationError.message :
              String(agentCreationError)
          }
        }
      }

      const [createdTool] = await db
        .insert(workflowTool)
        .values({
          type: tool.type,
          workspaceId: user.workspaceId,
          userId: user.id,
          value: processedValue,
          config: processedConfig,
        })
        .returning()

      createdTools.push(createdTool)

      // Map frontend tool ID to backend tool ID
      if (tool.id) {
        toolIdMap.set(tool.id, createdTool.id)
      }
    }

    // Create workflow step templates
    const stepIdMap = new Map<string, string>() // frontend step ID -> backend step ID
    const createdSteps: any[] = []

    // Sort nodes by step_order if available, otherwise by position.y
    const sortedNodes = [...requestData.nodes].sort((a, b) => {
      const orderA = a.data?.step?.metadata?.step_order ?? 999
      const orderB = b.data?.step?.metadata?.step_order ?? 999
      if (orderA !== orderB) return orderA - orderB
      return a.position.y - b.position.y
    })

    // First pass: create all steps to get their IDs
    for (const node of sortedNodes) {
      const stepData = node.data.step

      const [createdStep] = await db
        .insert(workflowStepTemplate)
        .values({
          workflowTemplateId: templateId,
          name: stepData.name,
          description: stepData.description || "",
          type: stepData.type === "form_submission" || stepData.type === "manual" ? "manual" : "automated",
          timeEstimate: 180, // Default time estimate
          metadata: {
            icon: stepData.metadata?.icon,
            step_order: stepData.metadata?.step_order,
            schema_version: stepData.metadata?.schema_version,
            user_instructions: stepData.metadata?.user_instructions,
            ai_model: stepData.metadata?.ai_model,
            automated_description: stepData.metadata?.automated_description,
            position: node.position,
            ...stepData.config,
          },
          prevStepIds: [], // Will be updated in second pass
          nextStepIds: [], // Will be updated in second pass
          toolIds: [], // Will be updated in second pass
        })
        .returning()

      createdSteps.push(createdStep)
      stepIdMap.set(stepData.id, createdStep.id)
    }

    // Second pass: update relationships based on edges
    for (const step of createdSteps) {
      const frontendStepId = [...stepIdMap.entries()].find(([_, backendId]) => backendId === step.id)?.[0]
      const correspondingNode = requestData.nodes.find((n: any) => n.data.step.id === frontendStepId)

      // Find edges where this step is involved
      const outgoingEdges = requestData.edges.filter((edge: any) => edge.source === frontendStepId)
      const incomingEdges = requestData.edges.filter((edge: any) => edge.target === frontendStepId)

      // Map frontend step IDs to backend step IDs
      const nextStepIds = outgoingEdges
        .map((edge: any) => stepIdMap.get(edge.target))
        .filter(Boolean)

      const prevStepIds = incomingEdges
        .map((edge: any) => stepIdMap.get(edge.source))
        .filter(Boolean)

      // Map tool IDs for this step
      const stepToolIds: string[] = []
      if (correspondingNode?.data?.tools) {
        for (const tool of correspondingNode.data.tools) {
          if (tool.id && toolIdMap.has(tool.id)) {
            stepToolIds.push(toolIdMap.get(tool.id)!)
          } else {
            // Find tool by type and config if no ID mapping
            const matchingTool = createdTools.find(t =>
              t.type === tool.type &&
              JSON.stringify(t.value) === JSON.stringify(tool.value || {})
            )
            if (matchingTool) {
              stepToolIds.push(matchingTool.id)
            }
          }
        }
      }

      // Update the step with relationships
      await db
        .update(workflowStepTemplate)
        .set({
          prevStepIds,
          nextStepIds,
          toolIds: stepToolIds,
        })
        .where(eq(workflowStepTemplate.id, step.id))
    }

    // Set root step (first step in the workflow - usually form submission or trigger)
    let rootStepId = null
    if (createdSteps.length > 0) {
      // Find the step with no incoming edges (root step)
      const rootStep = createdSteps.find(step => {
        const frontendStepId = [...stepIdMap.entries()].find(([_, backendId]) => backendId === step.id)?.[0]
        const hasIncomingEdges = requestData.edges.some((edge: any) => edge.target === frontendStepId)
        return !hasIncomingEdges
      })

      rootStepId = rootStep?.id || createdSteps[0].id

      // Update template with root step ID
      await db
        .update(workflowTemplate)
        .set({
          rootWorkflowStepTemplateId: rootStepId,
        })
        .where(eq(workflowTemplate.id, templateId))
    }

    // Return the complete workflow template with steps and tools
    const completeTemplate = {
      ...template,
      rootWorkflowStepTemplateId: rootStepId,
      steps: createdSteps,
      workflow_tools: createdTools,
    }

    // Check if workflow contains webhook tools and reload webhooks if needed
    if (hasWebhookTools(createdTools)) {
      Logger.info("🔄 Workflow contains webhook tools, triggering webhook reload...")
      const reloadResult = await triggerWebhookReload()
      if (reloadResult.success) {
        Logger.info(`✅ Webhooks reloaded successfully: ${reloadResult.count} webhooks active`)
      } else {
        Logger.warn(`⚠️ Webhook reload failed: ${reloadResult.error}`)
      }
    }

    return c.json({
      success: true,
      data: completeTemplate,
      message: `Created workflow template with ${createdSteps.length} steps and ${createdTools.length} tools`,
    })
  } catch (error) {
    Logger.error(error, "Failed to create complex workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Execute template (alias for ExecuteWorkflowTemplateApi)
export const ExecuteTemplateApi = ExecuteWorkflowTemplateApi

// Update workflow template
export const UpdateWorkflowTemplateApi = async (c: Context) => {
  try {
    const templateId = c.req.param("templateId")
    const requestData = await c.req.json()

    const [template] = await db
      .update(workflowTemplate)
      .set({
        name: requestData.name,
        description: requestData.description,
        version: requestData.version,
        status: requestData.status,
        config: requestData.config,
      })
      .where(eq(workflowTemplate.id, templateId))
      .returning()

    // Trigger webhook reload after template update (config might contain workflow changes)
    Logger.info("🔄 Template updated, triggering webhook reload to ensure webhooks are current...")
    const reloadResult = await triggerWebhookReload()
    if (reloadResult.success) {
      Logger.info(`✅ Webhooks reloaded successfully: ${reloadResult.count} webhooks active`)
    } else {
      Logger.warn(`⚠️ Webhook reload failed: ${reloadResult.error}`)
    }

    return c.json({
      success: true,
      data: template,
    })
  } catch (error) {
    Logger.error(error, "Failed to update workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Create workflow execution
export const CreateWorkflowExecutionApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(
      db,
      c.get(JwtPayloadKey)
    )
    const requestData = await c.req.json()

    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: requestData.workflowTemplateId,
        userId: user.id,
        workspaceId: user.workspaceId,
        name: requestData.name,
        description: requestData.description,
        metadata: requestData.metadata || {},
        status: "draft",
      })
      .returning()

    return c.json({
      success: true,
      data: execution,
    })
  } catch (error) {
    Logger.error(error, "Failed to create workflow execution")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// List workflow executions with filters, pagination, and sorting
export const ListWorkflowExecutionsApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const query = listWorkflowExecutionsQuerySchema.parse({
      id: c.req.query("id"),
      name: c.req.query("name"),
      from_date: c.req.query("from_date"),
      to_date: c.req.query("to_date"),
      limit: c.req.query("limit"),
      page: c.req.query("page"),
    })

    // Build where conditions
    const whereConditions = [
      eq(workflowExecution.workspaceId, user.workspaceId),
      eq(workflowExecution.userId, user.id)
    ]

    // Filter by ID (exact match)
    if (query.id) {
      whereConditions.push(eq(workflowExecution.id, query.id))
    }

    // Filter by name (partial match, case-insensitive)
    if (query.name) {
      whereConditions.push(ilike(workflowExecution.name, `%${query.name}%`))
    }

    // Filter by date range (using createdAt as startDate)
    if (query.from_date) {
      whereConditions.push(
        gte(workflowExecution.createdAt, new Date(query.from_date)),
      )
    }

    if (query.to_date) {
      whereConditions.push(
        lte(workflowExecution.createdAt, new Date(query.to_date)),
      )
    }

    // Calculate offset for pagination
    const offset = (query.page - 1) * query.limit

    // Build and execute query with filters, sorting, and pagination
    const baseQuery = db.select().from(workflowExecution)

    let executions
    if (whereConditions.length > 0) {
      executions = await baseQuery
        .where(and(...whereConditions))
        .orderBy(desc(workflowExecution.createdAt))
        .limit(query.limit)
        .offset(offset)
    } else {
      executions = await baseQuery
        .orderBy(desc(workflowExecution.createdAt))
        .limit(query.limit)
        .offset(offset)
    }

    // Get total count for pagination info
    const baseCountQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(workflowExecution)

    let totalCountResult
    if (whereConditions.length > 0) {
      totalCountResult = await baseCountQuery.where(and(...whereConditions))
    } else {
      totalCountResult = await baseCountQuery
    }

    const totalCount = totalCountResult[0].count

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / query.limit)
    const hasNextPage = query.page < totalPages
    const hasPreviousPage = query.page > 1

    return c.json({
      success: true,
      data: executions,
      pagination: {
        page: query.page,
        limit: query.limit,
        totalCount,
        totalPages,
        hasNextPage,
        hasPreviousPage,
      },
      filters: {
        id: query.id || null,
        name: query.name || null,
        from_date: query.from_date || null,
        to_date: query.to_date || null,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to list workflow executions")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Create workflow tool
export const CreateWorkflowToolApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const requestData = await c.req.json()

    const [tool] = await db
      .insert(workflowTool)
      .values({
        type: requestData.type,
        workspaceId: user.workspaceId,
        userId: user.id,
        value: requestData.value,
        config: requestData.config || {},
      })
      .returning()

    // If this is a webhook tool, register the webhook
    if (tool.type === ToolType.WEBHOOK && tool.config && tool.value) {
      try {
        const config = tool.config as any
        const value = tool.value as any
        
        if (config.path || value.path) {
          const webhookConfig = {
            webhookUrl: value.webhookUrl || `http://localhost:3000/workflow/webhook${config.path || value.path}`,
            httpMethod: config.httpMethod || 'POST',
            path: config.path || value.path,
            authentication: config.authentication || 'none',
            selectedCredential: config.selectedCredential,
            responseMode: config.responseMode || 'immediately',
            options: config.options || {},
            headers: config.headers || {},
            queryParams: config.queryParams || {}
          }
          
          // Get workflow template ID (simplified - in real implementation you'd get this from context)
          const templateId = requestData.workflowTemplateId || 'default-template'
          
          await webhookRegistry.registerWebhook(
            webhookConfig.path,
            templateId,
            tool.id,
            webhookConfig
          )
          
          Logger.info(`Registered webhook ${webhookConfig.path} for tool ${tool.id}`)
        }
      } catch (webhookError) {
        Logger.error(webhookError, `Failed to register webhook for tool ${tool.id}`)
        // Don't fail the tool creation if webhook registration fails
      }
    }

    return c.json({
      success: true,
      data: tool,
    })
  } catch (error) {
    Logger.error(error, "Failed to create workflow tool")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Update workflow tool
export const UpdateWorkflowToolApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const toolId = c.req.param("toolId")
    const requestData = await c.req.json()

    // Check if tool exists first
    const existingTool = await db
      .select()
      .from(workflowTool)
      .where(and(
        eq(workflowTool.workspaceId, user.workspaceId),
        eq(workflowTool.userId, user.id),
        eq(workflowTool.id, toolId),
      ))

    if (existingTool.length === 0) {
      throw new HTTPException(404, {
        message: "Workflow tool not found",
      })
    }

    // Use database transaction to update both tool and associated step
    const result = await db.transaction(async (trx) => {
      // Update tool fields that are provided
      const toolUpdateData: any = {}
      if (requestData.type !== undefined) toolUpdateData.type = requestData.type
      if (requestData.value !== undefined)
        toolUpdateData.value = requestData.value
      if (requestData.config !== undefined)
        toolUpdateData.config = requestData.config
      toolUpdateData.updatedAt = new Date()

      const [updatedTool] = await trx
        .update(workflowTool)
        .set(toolUpdateData)
        .where(eq(workflowTool.id, toolId))
        .returning()

      // Update associated step if stepName or stepDescription is provided
      let updatedStep = null
      if (
        requestData.stepName !== undefined ||
        requestData.stepDescription !== undefined
      ) {
        // Find step that uses this tool
        const stepWithTool = await trx
          .select()
          .from(workflowStepTemplate)
          .where(sql`${toolId} = ANY(${workflowStepTemplate.toolIds})`)

        if (stepWithTool.length > 0) {
          const stepUpdateData: any = {}
          if (requestData.stepName !== undefined)
            stepUpdateData.name = requestData.stepName
          if (requestData.stepDescription !== undefined)
            stepUpdateData.description = requestData.stepDescription
          stepUpdateData.updatedAt = new Date()

          const [updated] = await trx
            .update(workflowStepTemplate)
            .set(stepUpdateData)
            .where(eq(workflowStepTemplate.id, stepWithTool[0].id))
            .returning()

          updatedStep = updated
        }
      }

      return { tool: updatedTool, step: updatedStep }
    })

    // If this is a webhook tool, update the webhook registration
    if (result.tool.type === ToolType.WEBHOOK && result.tool.config && result.tool.value) {
      try {
        const config = result.tool.config as any
        const value = result.tool.value as any
        
        if (config.path || value.path) {
          const webhookConfig = {
            webhookUrl: value.webhookUrl || `http://localhost:3000/workflow/webhook${config.path || value.path}`,
            httpMethod: config.httpMethod || 'POST',
            path: config.path || value.path,
            authentication: config.authentication || 'none',
            selectedCredential: config.selectedCredential,
            responseMode: config.responseMode || 'immediately',
            options: config.options || {},
            headers: config.headers || {},
            queryParams: config.queryParams || {}
          }
          
          // Get workflow template ID (simplified - in real implementation you'd get this from context)
          const templateId = requestData.workflowTemplateId || 'default-template'
          
          // Unregister old webhook first (if path changed)
          if (existingTool[0] && existingTool[0].value) {
            const oldValue = existingTool[0].value as any
            if (oldValue.path && oldValue.path !== webhookConfig.path) {
              await webhookRegistry.unregisterWebhook(oldValue.path)
            }
          }
          
          // Register new/updated webhook
          await webhookRegistry.registerWebhook(
            webhookConfig.path,
            templateId,
            result.tool.id,
            webhookConfig
          )
          
          Logger.info(`Updated webhook registration ${webhookConfig.path} for tool ${result.tool.id}`)
        }
      } catch (webhookError) {
        Logger.error(webhookError, `Failed to update webhook for tool ${result.tool.id}`)
        // Don't fail the tool update if webhook registration fails
      }
    }

    return c.json({
      success: true,
      data: {
        tool: result.tool,
        step: result.step,
        message: result.step
          ? "Tool and associated step updated successfully"
          : "Tool updated successfully",
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to update workflow tool")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get single workflow tool
export const GetWorkflowToolApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const toolId = c.req.param("toolId")

    const [tool] = await db
      .select()
      .from(workflowTool)
      .where(and(
        eq(workflowTool.workspaceId, user.workspaceId),
        eq(workflowTool.userId, user.id),
        eq(workflowTool.id, toolId),
      ))

    if (!tool) {
      throw new HTTPException(404, {
        message: "Workflow tool not found",
      })
    }

    return c.json({
      success: true,
      data: tool,
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow tool")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Delete workflow tool
export const DeleteWorkflowToolApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const toolId = c.req.param("toolId")

    // Check if tool exists first
    const existingTool = await db
      .select()
      .from(workflowTool)
      .where(and(
        eq(workflowTool.workspaceId, user.workspaceId),
        eq(workflowTool.userId, user.id),
        eq(workflowTool.id, toolId),
      ))

    if (existingTool.length === 0) {
      throw new HTTPException(404, {
        message: "Workflow tool not found",
      })
    }

    await db.delete(workflowTool).where(eq(workflowTool.id, toolId))

    return c.json({
      success: true,
      message: "Workflow tool deleted successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to delete workflow tool")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Add step with tool to workflow template
export const AddStepToWorkflowApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const templateId = c.req.param("templateId")
    const requestData = await c.req.json()

    // Validate template exists
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

    // 1. Create the tool first
    const [newTool] = await db
      .insert(workflowTool)
      .values({
        type: requestData.tool.type,
        workspaceId: user.workspaceId,
        userId: user.id,
        value: requestData.tool.value,
        config: requestData.tool.config || {},
      })
      .returning()

    Logger.info(`Created new tool: ${newTool.id}`)

    // 2. Get all existing steps for this template
    const existingSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    const isFirstStep =
      existingSteps.length === 0 || !template.rootWorkflowStepTemplateId

    // 3. Create the new step
    const stepOrder = existingSteps.length + 1
    const [newStep] = await db
      .insert(workflowStepTemplate)
      .values({
        workflowTemplateId: templateId,
        name: requestData.stepName,
        description: requestData.stepDescription || `Step ${stepOrder}`,
        type: requestData.stepType || "automated",
        parentStepId: null,
        prevStepIds: isFirstStep ? [] : [],
        nextStepIds: [],
        toolIds: [newTool.id],
        timeEstimate: requestData.timeEstimate || 300,
        metadata: {
          icon: getStepIcon(requestData.tool.type),
          step_order: stepOrder,
          ...requestData.metadata,
        },
      })
      .returning()

    Logger.info(`Created new step: ${newStep.id}`)

    // 4. Handle step connections
    if (isFirstStep) {
      // This is the first/root step
      await db
        .update(workflowTemplate)
        .set({
          rootWorkflowStepTemplateId: newStep.id,
          updatedAt: new Date(),
        })
        .where(eq(workflowTemplate.id, templateId))

      Logger.info(`Set step ${newStep.id} as root step`)
    } else {
      // Find the current last step (step with no nextStepIds)
      const currentLastStep = existingSteps.find(
        (step) => !step.nextStepIds || step.nextStepIds.length === 0,
      )

      if (currentLastStep) {
        // Update the current last step to point to new step
        await db
          .update(workflowStepTemplate)
          .set({
            nextStepIds: [newStep.id],
            updatedAt: new Date(),
          })
          .where(eq(workflowStepTemplate.id, currentLastStep.id))

        // Update new step to have current last step as previous
        await db
          .update(workflowStepTemplate)
          .set({
            prevStepIds: [currentLastStep.id],
            updatedAt: new Date(),
          })
          .where(eq(workflowStepTemplate.id, newStep.id))

        Logger.info(`Connected step ${currentLastStep.id} -> ${newStep.id}`)
      }
    }

    // 5. Return the complete updated template with new step
    const updatedTemplate = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    const allSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    return c.json({
      success: true,
      data: {
        template: updatedTemplate[0],
        newStep: newStep,
        newTool: newTool,
        totalSteps: allSteps.length,
        isRootStep: isFirstStep,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to add step to workflow")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Helper function to get step icon based on tool type
function getStepIcon(toolType: string): string {
  const iconMap: Record<string, string> = {
    form: "📁",
    ai_agent: "🤖",
    email: "📧",
    slack: "💬",
    gmail: "📮",
    delay: "⏰",
    agent: "🤖",
    merged_node: "🔀",
  }
  return iconMap[toolType] || "⚙️"
}

// Delete workflow step template API
export const DeleteWorkflowStepTemplateApi = async (c: Context) => {
  try {
    const user = await getUserFromJWT(db, c.get(JwtPayloadKey))
    const stepId = c.req.param("stepId")

    // 1. Check if step exists and get its details
    const [stepToDelete] = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, stepId))

    if (!stepToDelete) {
      throw new HTTPException(404, {
        message: "Workflow step template not found",
      })
    }

    const templateId = stepToDelete.workflowTemplateId

    // 2. Get the workflow template
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

    // 3. Handle step chain reconnection
    const prevStepIds = stepToDelete.prevStepIds || []
    const nextStepIds = stepToDelete.nextStepIds || []

    // Update previous steps to point to next steps
    for (const prevStepId of prevStepIds) {
      await db
        .update(workflowStepTemplate)
        .set({
          nextStepIds: nextStepIds,
          updatedAt: new Date(),
        })
        .where(eq(workflowStepTemplate.id, prevStepId))
    }

    // Update next steps to point to previous steps
    for (const nextStepId of nextStepIds) {
      await db
        .update(workflowStepTemplate)
        .set({
          prevStepIds: prevStepIds,
          updatedAt: new Date(),
        })
        .where(eq(workflowStepTemplate.id, nextStepId))
    }

    // 5. Handle root step updates
    let newRootStepId = template.rootWorkflowStepTemplateId
    const isRootStep = template.rootWorkflowStepTemplateId === stepId

    if (isRootStep) {
      // If deleting root step, set the first next step as new root
      // If no next steps, set to null
      newRootStepId = nextStepIds.length > 0 ? nextStepIds[0] : null

      await db
        .update(workflowTemplate)
        .set({
          rootWorkflowStepTemplateId: newRootStepId,
          updatedAt: new Date(),
        })
        .where(eq(workflowTemplate.id, templateId))

      Logger.info(`Updated root step from ${stepId} to ${newRootStepId}`)
    }

    // 6. Delete associated tools if they are only used by this step
    const toolIdsToCheck = stepToDelete.toolIds || []

    for (const toolId of toolIdsToCheck) {
      // Check if any other steps use this tool
      const otherStepsUsingTool = await db
        .select()
        .from(workflowStepTemplate)
        .where(
          and(
            eq(workflowStepTemplate.workflowTemplateId, templateId),
            ne(workflowStepTemplate.id, stepId),
          ),
        )

      const toolInUse = otherStepsUsingTool.some(
        (step) => step.toolIds && step.toolIds.includes(toolId),
      )

      if (!toolInUse) {
        // Delete the tool if not used by other steps
        await db.delete(workflowTool).where(eq(workflowTool.id, toolId))
        Logger.info(`Deleted unused tool: ${toolId}`)
      }
    }

    // 7. Delete the step
    await db
      .delete(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, stepId))

    // 8. Update step orders for remaining steps
    const remainingSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Reorder remaining steps
    const sortedSteps = remainingSteps.sort((a, b) => {
      const orderA = (a.metadata as any)?.step_order || 0
      const orderB = (b.metadata as any)?.step_order || 0
      return orderA - orderB
    })

    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i]
      const newOrder = i + 1

      if ((step.metadata as any)?.step_order !== newOrder) {
        await db
          .update(workflowStepTemplate)
          .set({
            metadata: {
              ...(step.metadata || {}),
              step_order: newOrder,
            },
            updatedAt: new Date(),
          })
          .where(eq(workflowStepTemplate.id, step.id))
      }
    }

    // 9. Get updated workflow data
    const updatedTemplate = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    const updatedSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    Logger.info(
      `Successfully deleted step ${stepId} and reconnected workflow chain`,
    )

    return c.json({
      success: true,
      data: {
        deletedStepId: stepId,
        wasRootStep: isRootStep,
        newRootStepId: newRootStepId,
        remainingSteps: updatedSteps.length,
        template: updatedTemplate[0],
        message: `Step "${stepToDelete.name}" deleted successfully`,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to delete workflow step template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Update workflow step execution
export const UpdateWorkflowStepExecutionApi = async (c: Context) => {
  try {
    const stepId = c.req.param("stepId")
    const requestData = await c.req.json()

    const [stepExecution] = await db
      .update(workflowStepExecution)
      .set({
        status: requestData.status,
        completedBy: requestData.completedBy,
        completedAt: requestData.status === WorkflowStatus.COMPLETED ? new Date() : null,
        metadata: requestData.metadata,
      })
      .where(eq(workflowStepExecution.id, stepId))
      .returning()

    return c.json({
      success: true,
      data: stepExecution,
    })
  } catch (error) {
    Logger.error(error, "Failed to update workflow step execution")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Complete workflow step execution
export const CompleteWorkflowStepExecutionApi = async (c: Context) => {
  try {
    const stepId = c.req.param("stepId")

    const [stepExecution] = await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: "demo",
        completedAt: new Date(),
      })
      .where(eq(workflowStepExecution.id, stepId))
      .returning()

    return c.json({
      success: true,
      data: stepExecution,
    })
  } catch (error) {
    Logger.error(error, "Failed to complete workflow step execution")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Submit form step (alias for SubmitWorkflowFormApi)
export const SubmitFormStepApi = SubmitWorkflowFormApi

// Get form definition
export const GetFormDefinitionApi = async (c: Context) => {
  try {
    const stepId = c.req.param("stepId")

    const stepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.id, stepId))

    if (!stepExecutions || stepExecutions.length === 0) {
      throw new HTTPException(404, { message: "Step execution not found" })
    }

    const stepExecution = stepExecutions[0]
    const stepTemplate = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, stepExecution.workflowStepTemplateId))

    if (!stepTemplate || stepTemplate.length === 0) {
      throw new HTTPException(404, { message: "Step template not found" })
    }

    const toolIds = stepTemplate[0].toolIds || []
    if (toolIds.length === 0) {
      throw new HTTPException(400, {
        message: "No tools configured for this step",
      })
    }

    const formTool = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolIds[0]))

    if (!formTool || formTool.length === 0) {
      throw new HTTPException(404, { message: "Form tool not found" })
    }

    return c.json({
      success: true,
      data: {
        stepId: stepId,
        formDefinition: formTool[0].value,
        stepName: stepExecution.name,
        stepDescription: stepExecution.name, // Use name as description since description doesn't exist
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to get form definition")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Get VertexAI model enum names for workflow tools (replaces GetGeminiModelEnumsApi)
export const GetVertexAIModelEnumsApi = async (c: Context) => {
  try {
    const { MODEL_CONFIGURATIONS } = await import("@/ai/modelConfig")
    const { AIProviders } = await import("@/ai/types")

    // Get all VertexAI model enum values (includes both Claude and Gemini models)
    const vertexAIModelEnums = Object.entries(MODEL_CONFIGURATIONS)
      .filter(([_, config]) => config.provider === AIProviders.VertexAI)
      .map(([enumValue, config]) => ({
        enumValue, // e.g., "vertex-gemini-2-5-flash", "vertex-claude-sonnet-4"
        labelName: config.labelName, // e.g., "Gemini 2.5 Flash", "Claude Sonnet 4"
        actualName: config.actualName, // e.g., "gemini-2.5-flash", "claude-sonnet-4@20250514"
        description: config.description,
        reasoning: config.reasoning,
        websearch: config.websearch,
        deepResearch: config.deepResearch,
        // Add model type for better categorization in frontend
        modelType: enumValue.includes('gemini') ? 'gemini' :
          enumValue.includes('claude') ? 'claude' : 'other',
      }))
      .sort((a, b) => {
        const typeOrder: Record<string, number> = { claude: 1, gemini: 2, other: 3 };
        const orderA = typeOrder[a.modelType] ?? 99;
        const orderB = typeOrder[b.modelType] ?? 99;

        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return a.labelName.localeCompare(b.labelName);
      })

    return c.json({
      success: true,
      data: vertexAIModelEnums,
      count: vertexAIModelEnums.length,
      message: "VertexAI models include both Claude and Gemini models optimized for enterprise use",
    })
  } catch (error) {
    Logger.error(error, "Failed to get VertexAI model enums")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Legacy endpoint - kept for backward compatibility but redirects to VertexAI
export const GetGeminiModelEnumsApi = async (c: Context) => {
  Logger.warn("GetGeminiModelEnumsApi is deprecated, use GetVertexAIModelEnumsApi instead")
  return GetVertexAIModelEnumsApi(c)
}

// Serve workflow file
export const ServeWorkflowFileApi = async (c: Context) => {
  try {
    // This would serve files from workflow executions
    // For now, return a simple response
    return c.json({
      success: true,
      message: "File serving not implemented yet",
    })
  } catch (error) {
    Logger.error(error, "Failed to serve workflow file")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}
