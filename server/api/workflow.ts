import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { WorkflowStatus, StepType, ToolType, ToolExecutionStatus } from "@/types/workflowTypes"
import { type SelectAgent } from "../db/schema"
import { type ExecuteAgentResponse } from "./agent/workflowAgentUtils"
import JSZip from "jszip"
import { readFile } from "node:fs/promises"

// Schema for workflow executions query parameters
const listWorkflowExecutionsQuerySchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  from_date: z.string().optional(), // ISO date string
  to_date: z.string().optional(), // ISO date string
  limit: z.coerce.number().min(1).max(100).optional().default(10),
  page: z.coerce.number().min(1).optional().default(1),
})
import { ExecuteAgentForWorkflow } from "./agent/workflowAgentUtils"
import { mkdir } from "node:fs/promises"
import path from "node:path"
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
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { createAgentForWorkflow } from "./agent/workflowAgentUtils"
import { type CreateAgentPayload } from "./agent"
import {
  eq,
  sql,
  inArray,
  and,
  gte,
  lte,
  ilike,
  desc,
  asc,
  ne,
} from "drizzle-orm"

import { type AttachmentMetadata } from "@/shared/types"

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
  reviewSubmissionSchema,
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
import { getActualNameFromEnum } from "@/ai/modelConfig"
import { getProviderByModel } from "@/ai/provider"
import { Models } from "@/ai/types"
import type { Message } from "@aws-sdk/client-bedrock-runtime"
import { executeScript, ScriptLanguage } from "@/workflowScriptExecutorTool"

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
    const templates = await db.select().from(workflowTemplate)

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
    const templateId = c.req.param("templateId")

    const template = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Debug logging to check toolIds
    Logger.info(`GetWorkflowTemplateApi: Found ${steps.length} steps for template ${templateId}`)
    steps.forEach((step, index) => {
      Logger.info(`Step ${index + 1} (${step.name}): toolIds = ${JSON.stringify(step.toolIds)}`)
    })

    const toolIds = steps.flatMap((s) => s.toolIds || [])
    Logger.info(`GetWorkflowTemplateApi: Flattened toolIds = ${JSON.stringify(toolIds)}`)
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
  let workspaceId: string = ""
  let via_apiKey = false
  try {
    let jwtPayload
    try {
      jwtPayload = c.get(JwtPayloadKey)
    } catch (e) {
      Logger.info("No JWT payload found in context")
    }

    if (jwtPayload?.sub && jwtPayload?.workspaceId) {
      email = jwtPayload.sub
      workspaceId = jwtPayload.workspaceId
      via_apiKey = false

    } else {
      // Try API key context
      email = c.get("userEmail")
      workspaceId = c.get("workspaceId")
      via_apiKey = true
    }

    // Get user ID for agent creation
    const userAndWorkspace = await getUserAndWorkspaceByEmail(db, workspaceId, email)
    const userId = userAndWorkspace.user.id
    const workspaceInternalId = userAndWorkspace.workspace.id

    Logger.debug(`Debug-ExecuteWorkflowWithInputApi: userId=${userId}, workspaceInternalId=${workspaceInternalId}`)

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

    // Get template and validate to check if root step is trigger type
    const template = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    if (!template[0].rootWorkflowStepTemplateId) {
      throw new HTTPException(400, {
        message: "Template has no root step configured",
      })
    }

    // Get root step template to check if it's a trigger type
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

    // Get root step tool to check if it's a trigger
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

    // Check if root step is a trigger - if so, allow execution without input
    const isTriggerRootStep = rootStep.type === StepType.MANUAL && rootStepTool?.type === ToolType.TRIGGER

    // Validate required fields - skip validation for trigger root steps
    if (!isTriggerRootStep && !requestData.rootStepInput) {
      throw new HTTPException(400, { message: "rootStepInput is required" })
    }

    // Provide empty input for trigger steps
    if (isTriggerRootStep && !requestData.rootStepInput) {
      requestData.rootStepInput = {}
    }

    // Validate input based on root step type (skip validation for trigger tools)
    if (rootStep.type === StepType.MANUAL && rootStepTool?.type === ToolType.FORM && !isTriggerRootStep) {
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
        createdBy: "api",
        name:
          requestData.name ||
          `${template[0].name} - ${new Date().toLocaleDateString()}`,
        description:
          requestData.description || `Execution of ${template[0].name}`,
        metadata: {
          ...requestData.metadata,
          executionContext: {
            userEmail: email,
            workspaceId: workspaceId,
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

    // Update step statuses to activate steps that are ready
    await updateDownstreamStepStatuses(execution.id)

    // Process file uploads and create tool execution
    let toolExecutionRecord = null
    let processedFormData = { ...requestData.rootStepInput }

    if (rootStepTool && rootStepTool.type === ToolType.FORM) {
      // Handle file uploads if present
      if (contentType.includes("multipart/form-data")) {
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
                          sub: email,
                          workspaceId: workspaceId
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
                    const attachments : AttachmentMetadata[] = attachmentResult.attachments
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

      // Mark root step as completed (only for form tools)
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
    }

    // Auto-execute next automated steps (only for completed form tools)
    const allTools = await db.select().from(workflowTool)
    const rootStepName = rootStepExecution.name || "Root Step"
    const currentResults: Record<string, any> = {}

    // Determine response based on whether root step was completed or is awaiting input
    const isRootStepCompleted = rootStepTool && rootStepTool.type === ToolType.FORM
    const responseMessage = isRootStepCompleted 
      ? "Workflow started successfully - automated steps running in background"
      : "Workflow created successfully - awaiting manual input for root step"

    if (isRootStepCompleted) {
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
    }

    // Return response immediately and execute automated steps in parallel (only if root step completed)
    const responseData = {
      success: true,
      message: responseMessage,
      data: {
        execution: {
          ...execution,
          rootWorkflowStepExeId: rootStepExecution.id,
        },
        rootStepExecution: {
          ...rootStepExecution,
          status: isRootStepCompleted ? ToolExecutionStatus.COMPLETED : rootStepExecution.status,
        },
        toolExecution: toolExecutionRecord,
        statusPollingUrl: `/api/v1/workflow/executions/${execution.id}/status`,
      },
    }

    // Execute automated steps in background (non-blocking) - only if root step is completed
    if (
      isRootStepCompleted &&
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
    const templateId = c.req.param("templateId")
    const requestData = await c.req.json()

    // Get template
    const template = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    // Get step templates
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Get tools
    const tools = await db.select().from(workflowTool)

    // Create workflow execution
    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: template[0].id,
        createdBy: "demo",
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
    } else {
      // Check if any completed step is a leaf node (has no next steps that are executed)
      const leafNodeCompleted = completedSteps.some(completedStep => {
        // A step is a leaf node if it has no next steps OR all its next steps are unexecuted (draft)
        const nextStepIds = completedStep.nextStepIds || []
        if (nextStepIds.length === 0) {
          // No next steps - definitely a leaf node
          return true
        }
        
        // Check if all next steps are unexecuted (not in executedSteps)
        const executedStepIds = executedSteps.map(s => s.id)
        const allNextStepsUnexecuted = nextStepIds.every(nextId => 
          !executedStepIds.includes(nextId)
        )
        
        return allNextStepsUnexecuted
      })

      if (leafNodeCompleted) {
        shouldComplete = true
        completionReason = "Leaf node completed - workflow finished"
        Logger.info(`Detected leaf node completion in workflow ${executionId}`)
      } else if (activeSteps.length === 0 && manualStepsAwaitingInput.length === 0) {
        // No active steps and no manual steps awaiting input
        // This means we've reached the end of the execution path
        shouldComplete = true
        completionReason = "End of execution path reached"
      } else {
        // There are still active steps or manual steps awaiting input
        shouldComplete = false
      }
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
// Function to send email notifications when review steps become active
const sendReviewNotificationIfNeeded = async (step: any) => {
  try {
    // Check if this step is a manual step (which could be a review step)
    if (step.type !== StepType.MANUAL) {
      return
    }

    // Get the step template to find the associated tools
    const stepTemplate = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, step.workflowStepTemplateId))

    if (!stepTemplate || stepTemplate.length === 0) {
      return
    }

    const toolIds = stepTemplate[0].toolIds || []
    if (toolIds.length === 0) {
      return
    }

    // Get the tools for this step
    const tools = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolIds[0])) // Assuming first tool is the primary tool

    if (!tools || tools.length === 0) {
      return
    }

    const tool = tools[0]

    // Check if this is a review tool with email configuration
    if (tool.type === ToolType.REVIEW && tool.config) {
      const reviewConfig = tool.config as any
      const emailAddresses = reviewConfig.email_addresses || []
      const emailMessage = reviewConfig.email_message || ""

      if (emailAddresses.length > 0 && emailMessage) {
        const { emailService } = await import("@/services/emailService")

        // Get workflow execution info for email context
        const [execution] = await db
          .select()
          .from(workflowExecution)
          .where(eq(workflowExecution.id, step.workflowExecutionId))

        const workflowName = execution?.name || "Unknown Workflow"
        const subject = `Review Required: ${workflowName} - ${step.name}`

        // Send email to all configured addresses
        const emailPromises = emailAddresses.map(async (email: string) => {
          try {
            const emailSent = await emailService.sendEmail({
              to: email,
              subject: subject,
              body: emailMessage,
              contentType: "text",
            })

            if (emailSent) {
              Logger.info(`✅ Review activation email sent to: ${email} for step: ${step.name}`)
            } else {
              Logger.warn(`⚠️  Failed to send review activation email to: ${email}`)
            }

            return { email, success: emailSent }
          } catch (emailError) {
            Logger.error(`❌ Error sending review activation email to ${email}:`, emailError)
            return { email, success: false, error: emailError }
          }
        })

        const emailResults = await Promise.all(emailPromises)
        const successfulEmails = emailResults.filter(result => result.success).length

        Logger.info(`📧 Review activation emails sent: ${successfulEmails}/${emailAddresses.length} for step: ${step.name}`)
      }
    }
  } catch (error) {
    Logger.error(error, `Failed to send review notification for step: ${step.name}`)
  }
}

// Function to update downstream step statuses when their prerequisites are met
const updateDownstreamStepStatuses = async (executionId: string) => {
  try {
    // Get all step executions for this workflow
    const allSteps = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    // Find steps that are in DRAFT status and check if they can be activated
    const draftSteps = allSteps.filter(step => step.status === WorkflowStatus.DRAFT)
    
    for (const step of draftSteps) {
      const prevStepIds = step.prevStepIds || []
      
      if (prevStepIds.length === 0) {
        // Root step - should be active if not already completed
        if (step.status === WorkflowStatus.DRAFT) {
          await db
            .update(workflowStepExecution)
            .set({ status: WorkflowStatus.ACTIVE })
            .where(eq(workflowStepExecution.id, step.id))

          // Check if this is a review step and send email notifications
          await sendReviewNotificationIfNeeded(step)
        }
      } else {
        // Check if all previous steps are completed
        const prevSteps = allSteps.filter(s => 
          prevStepIds.includes(s.workflowStepTemplateId)
        )
        
        const allPrevStepsCompleted = prevSteps.length > 0 && 
          prevSteps.every(s => s.status === WorkflowStatus.COMPLETED)
        
        if (allPrevStepsCompleted && step.status === WorkflowStatus.DRAFT) {
          await db
            .update(workflowStepExecution)
            .set({ status: WorkflowStatus.ACTIVE })
            .where(eq(workflowStepExecution.id, step.id))

          // Check if this is a review step and send email notifications
          await sendReviewNotificationIfNeeded(step)
        }
      }
    }
  } catch (error) {
    Logger.error(error, "Failed to update downstream step statuses")
  }
}

const executeWorkflowChain = async (
  executionId: string,
  currentStepId: string,
  previousResults: any,
) => {
  try {
    // Get current step execution
    const stepExecution = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.id, currentStepId))
    if (!stepExecution || stepExecution.length === 0) {
      return previousResults
    }

    const step = stepExecution[0]

    // If step is manual, wait for user input
    if (step.type === StepType.MANUAL) {
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

    // Fetch the current tool data from database to get latest updates
    const toolFromDb = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolId))
    
    if (!toolFromDb || toolFromDb.length === 0) {
      return previousResults
    }

    const tool = toolFromDb[0]

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
        Logger.warn("Database insert failed for failed tool, creating minimal record:", dbError)
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
      Logger.warn("Database insert failed, sanitizing result:", dbError)

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
          "Second database insert failed, creating minimal record:",
          secondError,
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

    // Update status of downstream steps that can now be activated
    await updateDownstreamStepStatuses(executionId)

    // Store results for next step
    const updatedResults = {
      ...(previousResults || {}),
      [step.name]: {
        stepId: step.id,
        result: toolResult.result,
        toolExecution: toolExecutionRecord,
      },
    }

    // Find and execute next steps using UUID arrays
    if (step.nextStepIds && Array.isArray(step.nextStepIds)) {
      for (const nextStepId of step.nextStepIds) {
        const nextSteps = await db
          .select()
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.workflowExecutionId, executionId))

        const nextStep = nextSteps.find(
          (s) => s.workflowStepTemplateId === nextStepId,
        )

        if (nextStep && nextStep.type === StepType.AUTOMATED) {
          // Recursively execute next automated step
          // workflow-TODO: consider parallel execution , this is only for sequential steps
          await executeWorkflowChain(
            executionId,
            nextStep.id,
            updatedResults,
          )
        }
      }
    }

    // Check if this was the last step and mark workflow as completed if so
    const allStepExecutions = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, executionId))

    const allStepsCompleted = allStepExecutions.every(
      (stepExec) => stepExec.status === WorkflowStatus.COMPLETED,
    )

    if (allStepsCompleted) {
      // Check if workflow execution is not already completed
      const [currentExecution] = await db
        .select()
        .from(workflowExecution)
        .where(eq(workflowExecution.id, executionId))

      if (currentExecution && currentExecution.status !== WorkflowStatus.COMPLETED) {
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
    }

    return updatedResults
  } catch (error) {
    Logger.error(error, "Failed to execute workflow chain")
    return previousResults
  }
}

// Get workflow execution status (enhanced for polling with step details)
export const GetWorkflowExecutionStatusApi = async (c: Context) => {
  try {
    const executionId = c.req.param("executionId")

    // Get execution with current step details
    const execution = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

    if (!execution || execution.length === 0) {
      throw new HTTPException(404, { message: "Workflow execution not found" })
    }

    // Get the current active step execution
    const currentStepExecution = await db
      .select()
      .from(workflowStepExecution)
      .where(
        and(
          eq(workflowStepExecution.workflowExecutionId, executionId),
          eq(workflowStepExecution.status, "active")
        )
      )
      .limit(1)

    let currentStep = null
    let requiresUserInput = false

    if (currentStepExecution.length > 0) {
      const stepExec = currentStepExecution[0]
      
      // Get the step template to determine type
      const stepTemplate = await db
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.id, stepExec.workflowStepTemplateId))
        .limit(1)

      if (stepTemplate.length > 0) {
        const step = stepTemplate[0]
        currentStep = {
          id: stepExec.id,
          name: step.name,
          type: step.type,
          description: step.description,
          metadata: step.metadata
        }
        
        // Determine if user input is required
        requiresUserInput = step.type === 'manual' || 
                          stepExec.status === 'waiting_for_user' 
      }
    }

    return c.json({
      success: true,
      status: execution[0].status,
      currentStep: currentStep,
      requiresUserInput: requiresUserInput,
      executionId: executionId
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
    const executionId = c.req.param("executionId")

    // Get execution directly by ID
    const execution = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

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
        toolConfig: workflowTool.config,
      })
      .from(toolExecution)
      .leftJoin(workflowTool, eq(toolExecution.workflowToolId, workflowTool.id))
      .where(eq(toolExecution.workflowExecutionId, executionId))

    // Get workflow template to access workflow tools
    const workflowTemplateData = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, execution[0].workflowTemplateId))

    // Get step templates to map toolIds to workflow_tool_ids
    const stepTemplates = workflowTemplateData.length > 0 ? await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, workflowTemplateData[0].id))
      : []

    // Get all workflow tools for the template through step templates
    const allToolIds: string[] = []
    stepTemplates.forEach(stepTemplate => {
      if (stepTemplate.toolIds) {
        allToolIds.push(...stepTemplate.toolIds)
      }
    })
    
    const workflowTools = allToolIds.length > 0 ? await db
      .select()
      .from(workflowTool)
      .where(inArray(workflowTool.id, allToolIds))
      : []

    // Enhance step executions with workflow_tool_ids
    const enhancedStepExecutions = stepExecutions.map(stepExec => {
      // Find the corresponding step template
      const stepTemplate = stepTemplates.find(st => st.id === stepExec.workflowStepTemplateId)
      
      return {
        ...stepExec,
        workflow_tool_ids: stepTemplate?.toolIds || []
      }
    })

    // Process toolExecutions to only include config for review tools
    const processedToolExecutions = toolExecutions.map(te => ({
      ...te,
      toolConfig: te.toolType === 'review' ? te.toolConfig : undefined
    }))

    return c.json({
      success: true,
      data: {
        ...execution[0],
        stepExecutions: enhancedStepExecutions,
        toolExecutions: processedToolExecutions,
        workflow_tools: workflowTools,
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

// Unified Python script execution function
const executePythonScript = async (
  scriptContent: string,
  previousStepResults: any,
  config: any,
  scriptType: string = "python_script",
) => {
  try {
    // Create a temporary directory for the script execution
    const tempDir = `/tmp/${scriptType}_scripts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    await mkdir(tempDir, { recursive: true })

    // Write the script to a temporary file
    const scriptPath = `${tempDir}/script.py`

    // Prepare the script with context injection
    const previousStepResultsJson = JSON.stringify(previousStepResults)
      .replace(/null/g, "None")
      .replace(/true/g, "True")
      .replace(/false/g, "False")
    const configJson = JSON.stringify(config || {})
      .replace(/null/g, "None")
      .replace(/true/g, "True")
      .replace(/false/g, "False")

    const scriptWithContext = `
import json
import sys
import os
from datetime import datetime

# Inject previous step results and config
previous_step_results = ${previousStepResultsJson}
config = ${configJson}

# Original script content
${scriptContent}

# Ensure result is available and print it as JSON for capture
if 'result' in locals():
    print(json.dumps(result))
else:
    print(json.dumps({"status": "error", "error_message": "Script did not produce a result variable"}))
`

    await Bun.write(scriptPath, scriptWithContext)

    // Execute the Python script using Bun's spawn
    const proc = Bun.spawn(["python3", scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: tempDir,
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    // Clean up temporary files
    try {
      const fs = await import("node:fs/promises")
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (cleanupError) {
      Logger.warn(
        `Failed to cleanup temporary ${scriptType} files:`,
        cleanupError,
      )
    }

    if (proc.exitCode !== 0) {
      return {
        status: "error",
        result: {
          error: `${scriptType} execution failed`,
          stderr: stderr,
          stdout: stdout,
          exit_code: proc.exitCode,
        },
      }
    }

    if (stderr && stderr.trim()) {
      Logger.warn(`${scriptType} stderr:`, stderr)
    }

    // Parse the output as JSON
    try {
      const result = JSON.parse(stdout.trim())
      return {
        status: "success",
        result: result,
      }
    } catch (parseError) {
      return {
        status: "error",
        result: {
          error: `Failed to parse ${scriptType} output as JSON`,
          raw_output: stdout,
          stderr: stderr,
          parse_error:
            parseError instanceof Error
              ? parseError.message
              : String(parseError),
        },
      }
    }
  } catch (error) {
    return {
      status: "error",
      result: {
        error: `${scriptType} execution failed`,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

// Helper function to extract content from previous step results using simplified input paths
// Workflow-Todo: This function can be enhanced to support more complex path syntaxes if needed, currently this 
const extractContentFromPath = (
  previousStepResults: any,
  contentPath: string,
): string | null => {
  try {

    if (!contentPath.startsWith("input.")) {
      return `Invalid path: ${contentPath}. Only paths starting with 'input.' are supported.`
    }

    // Get all step keys
    const stepKeys = Object.keys(previousStepResults)
    if (stepKeys.length === 0) {
      return null
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
          return null
        }
      }

      // Convert result to string
      if (typeof target === "string") {
        return target
      } else if (target !== null && target !== undefined) {
        return JSON.stringify(target, null, 2)
      }
    }

    return null
  } catch (error) {
    return null
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

    if (!execution || !execution.metadata) {
      Logger.warn(`No execution context found for execution ${executionId}`)
      return null
    }

    // Check if execution context was stored in metadata
  
    const context = execution.metadata as any
    if (context.executionContext) {
      return context.executionContext
    }

    Logger.warn(`No execution context in metadata for execution ${executionId}`)
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
      case "review":
        // Check if email notification is configured
        const reviewConfig = tool.config || {}
        const emailAddresses = reviewConfig.email_addresses || []
        const emailMessage = reviewConfig.email_message || ""
        
        // Send email notification if email addresses are configured
        if (emailAddresses.length > 0 && emailMessage) {
          try {
            const { emailService } = await import("@/services/emailService")
            
            // Get workflow execution info for email context
            const [execution] = await db
              .select()
              .from(workflowExecution)
              .where(eq(workflowExecution.id, executionId))
            
            const workflowName = execution?.name || "Unknown Workflow"
            const subject = `Review Required: ${workflowName}`
            
            // Send email to all configured addresses
            const emailPromises = emailAddresses.map(async (email: string) => {
              try {
                const emailSent = await emailService.sendEmail({
                  to: email,
                  subject: subject,
                  body: emailMessage,
                  contentType: "text",
                })
                
                if (emailSent) {
                  Logger.info(`✅ Review notification email sent to: ${email}`)
                } else {
                  Logger.warn(`⚠️  Failed to send review notification email to: ${email}`)
                }
                
                return { email, success: emailSent }
              } catch (emailError) {
                Logger.error(`❌ Error sending review email to ${email}:`, emailError)
                return { email, success: false, error: emailError }
              }
            })
            
            const emailResults = await Promise.all(emailPromises)
            const successfulEmails = emailResults.filter(result => result.success).length
            
            Logger.info(`📧 Review notification emails sent: ${successfulEmails}/${emailAddresses.length}`)
            
          } catch (error) {
            Logger.error("Error sending review notification emails:", error)
          }
        }
        
        // Review tools are handled by review submission API
        return {
          status: "awaiting_user_input",
          result: {
            reviewDefinition: tool.value,
            config: tool.config, // Contains approved/rejected step IDs
            message: "User review required - approve or reject to continue",
            emailNotificationSent: emailAddresses.length > 0 && emailMessage,
          },
        }

      case "trigger":
        // Trigger tools are handled by trigger completion API
        return {
          status: "awaiting_user_input",
          result: {
            triggerDefinition: tool.value,
            config: tool.config,
            message: "Manual trigger required - mark as complete to continue workflow",
          },
        }

      case "python_script":
        // Execute actual Python script from database using unified function
        const pythonScriptContent =
          typeof tool.value === "string" ? tool.value : tool.value?.script
        const config = tool.config

        if (!pythonScriptContent) {
          return {
            status: "error",
            result: { error: "No script content found in tool value" },
          }
        }

        // Use unified Python execution function
        return await executePythonScript(
          pythonScriptContent,
          previousStepResults,
          config,
          "python_script",
        )

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
            emailBody = extractContentFromPath(previousStepResults, contentPath) || ""
          }

          // Try fallback paths if contentPath failed or wasn't provided
          if (!emailBody) {
            emailBody = extractContentFromPath(previousStepResults, "input.aiOutput") || ""
          }

          if (!emailBody) {
            emailBody = extractContentFromPath(previousStepResults, "input.output.body") || ""
          }

          if (!emailBody) {
            emailBody = extractContentFromPath(previousStepResults, "input.output") || ""
          }

          if (!emailBody) {
            emailBody = "No content available from previous step"
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
            <p>Generated on: ${new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"})}</p>
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
          // Get execution context for user info
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

          // Process input content based on input type
          let userQuery = ""
          let imageAttachmentIds: string[] = []
          let documentAttachmentIds: string[] = []

          if (aiConfig.inputType === "form") {
            // Extract form data from previous step - corrected data path
            const stepKeys = Object.keys(previousStepResults)

            if (stepKeys.length > 0) {
              const latestStepKey = stepKeys[stepKeys.length - 1]
              const prevStepData = previousStepResults[latestStepKey]

              // Try multiple possible paths for form data
              const formSubmission =
                prevStepData?.formSubmission?.formData ||
                prevStepData?.result?.formData ||
                prevStepData?.toolExecution?.result?.formData ||
                {}

              const extractedIds = extractAttachmentIds(formSubmission)
              imageAttachmentIds = extractedIds.imageAttachmentIds
              documentAttachmentIds = extractedIds.documentAttachmentIds

              // Process text fields
              const textFields = Object.entries(formSubmission)
                .filter(([key, value]) => typeof value === "string")
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n")

              userQuery = `${prompt}\n\nForm Data:\n${textFields}`
            } else {
              Logger.warn("No previous step data found")
              userQuery = prompt
            }
          } else {
            const stepKeys = Object.keys(previousStepResults)
            if (stepKeys.length > 0) {
              const latestStepKey = stepKeys[stepKeys.length - 1]
              const prevStepData = previousStepResults[latestStepKey]
              const content = prevStepData?.result?.output ||
                prevStepData?.result?.content ||
                JSON.stringify(prevStepData?.result || {})
              userQuery = `${prompt}\n\nContent to analyze:\n${content}`
            } else {
              userQuery = prompt
            }
          }
          const result: ExecuteAgentResponse = await ExecuteAgentForWorkflow({
            agentId,
            userQuery,
            workspaceId,
            userEmail,
            isStreamable: false,
            temperature,
            attachmentFileIds: imageAttachmentIds,
            nonImageAttachmentFileIds: documentAttachmentIds,
          })

          if (!result.success) {
            return {
              status: "error",
              result: {
                error: "Agent execution failed",
                details: result.error,
              }
            }
          }

          // Extract response from agent result
          const agentResponse = result.type === 'streaming'
            ? "Streaming response completed"
            : result.response.text

          return {
            status: "success",
            result: {
              aiOutput: agentResponse,
              agentName: result.agentName,
              model: result.modelId,
              chatId: result.chatId,
              inputType: aiConfig.inputType || "text",
              processedAt: new Date().toISOString(),
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

      case "script":
        // Execute script using unified script executor
        const scriptContent = tool.value.script
        const scriptConfig = tool.value.config
        const language = tool.value.language
        Logger.info(`Executing script in language: ${language}`)
        if (!scriptContent) {
          return {
            status: "error",
            result: { error: "No script content found in tool value" },
          }
        }

        // Map language string to ScriptLanguage enum
        let scriptLanguage: ScriptLanguage
        switch (language.toLowerCase()) {
          case "python":
            scriptLanguage = ScriptLanguage.Python
            break
          case "javascript":
          case "js":
            scriptLanguage = ScriptLanguage.JavaScript
            break
          case "r":
            scriptLanguage = ScriptLanguage.R
            break
          default:
            return {
              status: "error",
              result: { error: `Unsupported script language: ${language}` },
            }
        }
        try {
          // Extract the latest step's result for script input
          let scriptInput = previousStepResults
          
          // If we have structured step results, extract the latest step's output
          if (previousStepResults && typeof previousStepResults === 'object') {
            const stepKeys = Object.keys(previousStepResults)
            if (stepKeys.length > 0) {
              const latestStepKey = stepKeys[stepKeys.length - 1]
              const latestStep = previousStepResults[latestStepKey]
              
              // Use the latest step's result as the script input
              if (latestStep?.result) {
                scriptInput = latestStep.result
                Logger.info(`Using latest step '${latestStepKey}' result as script input`)
              } else if (latestStep?.formSubmission) {
                // For form steps, use the form data
                scriptInput = latestStep.formSubmission
                Logger.info(`Using latest step '${latestStepKey}' form data as script input`)
              } else {
                Logger.warn(`Latest step '${latestStepKey}' has no result or formData, using full object`)
                scriptInput = previousStepResults
              }
            }
          }
          
          const executionResult = await executeScript({
            type: "complete",
            language: scriptLanguage,
            script: scriptContent,
            input: scriptInput,
            config: scriptConfig,
          }, executionId)

          if (executionResult.success) {
            return {
              status: "success",
              result: {
                output: executionResult.output,
                consoleLogs: executionResult.consoleLogs,
                extractedFiles: executionResult.extractedFiles,
                language: language,
                exitCode: executionResult.exitCode,
                processedAt: new Date().toISOString(),
              },
            }
          } else {
            return {
              status: "error",
              result: {
                error: executionResult.error || "Script execution failed",
                consoleLogs: executionResult.consoleLogs,
                language: language,
                exitCode: executionResult.exitCode,
              },
            }
          }
        } catch (error) {
          return {
            status: "error",
            result: {
              error: "Script execution failed",
              message: error instanceof Error ? error.message : String(error),
              language: language,
            },
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
    const tools = await db.select().from(workflowTool)

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
    const requestData = await c.req.json()

    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name: requestData.name,
        description: requestData.description,
        version: requestData.version || "1.0.0",
        status: "draft",
        config: requestData.config || {},
        createdBy: "demo",
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

    let jwtPayload
    try {
      jwtPayload = c.get(JwtPayloadKey)
    } catch (e) {
      Logger.info("No JWT payload found in context")
    }

    const userEmail = jwtPayload?.sub
    if (!userEmail) {
      throw new HTTPException(401, { message: "Unauthorized - no user email" })
    }

    // Get workspace ID from JWT payload
    const workspaceId = jwtPayload?.workspaceId
    if (!workspaceId) {
      throw new HTTPException(400, { message: "No workspace ID in token" })
    }

    // Get user ID for agent creation
    const userAndWorkspace = await getUserAndWorkspaceByEmail(db, workspaceId, userEmail)
    const userId = userAndWorkspace.user.id
    const workspaceInternalId = userAndWorkspace.workspace.id

    const requestData = await c.req.json()
   
    // Create the main workflow template
    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name: requestData.name,
        description: requestData.description,
        version: requestData.version || "1.0.0",
        status: "draft",
        config: requestData.config || {},
        createdBy: "demo",
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
          Logger.info(`Creating agent for AI agent tool: ${JSON.stringify(tool.value)}`)

          // Extract agent data from tool configuration
          const agentData: CreateAgentPayload = {
            name: tool.value?.name || `Workflow Agent - ${template.name}`,
            description: tool.value?.description || "Auto-generated agent for workflow execution",
            prompt: tool.value?.systemPrompt || "You are a helpful assistant that processes workflow data.",
            model: tool.value?.model || "googleai-gemini-2-5-flash", // Use model from tool config
            isPublic: false, // Workflow agents are private by default
            appIntegrations: [], // No app integrations for workflow agents
            allowWebSearch: false, // Disable web search for workflow agents
            isRagOn: false, // Disable RAG for workflow agents
            uploadedFileNames: [], // No uploaded files for workflow agents
            docIds: [], // No document IDs for workflow agents
            userEmails: [] // No additional users for permissions
          }

          Logger.info(`Creating agent with data: ${JSON.stringify(agentData)}`)

          // Create the agent using createAgentForWorkflow
          const newAgent: SelectAgent = await createAgentForWorkflow(agentData, userId, workspaceInternalId)

          Logger.info(`Successfully created agent: ${newAgent.externalId} for workflow tool`)

          // Store the agent ID in the tool config for later use
          processedConfig = {
            ...processedConfig,
            inputType: "form",
            agentId: newAgent.externalId, // ← This replaces the hardcoded agent ID
            createdAgentId: newAgent.externalId, // Store backup reference
            agentName: newAgent.name,
            dynamicallyCreated: true // Flag to indicate this was auto-created
          }

          Logger.info(`Tool config updated with agent ID: ${newAgent.externalId}`)

        } catch (agentCreationError) {
          Logger.error(agentCreationError, `Failed to create agent for workflow tool, using fallback config`)

          // Fallback to original behavior if agent creation fails
          processedConfig = {
            ...processedConfig,
            inputType: "form",
            agentCreationFailed: true,
            agentCreationError: agentCreationError instanceof Error ? agentCreationError.message : String(agentCreationError)
          }
        }
      }

      const [createdTool] = await db
        .insert(workflowTool)
        .values({
          type: tool.type,
          value: processedValue,
          config: processedConfig,
          createdBy: "demo",
        })
        .returning()

      createdTools.push(createdTool)

      // Map frontend tool ID to backend tool ID
      if (tool.id) {
        toolIdMap.set(tool.id, createdTool.id)
      } else {
        // For tools without frontend IDs, create a temporary mapping based on type and content
        const tempId = `${tool.type}_${JSON.stringify(tool.value || {}).slice(0, 50)}`
        toolIdMap.set(tempId, createdTool.id)
        // Also store the original tool reference for matching
        tool._tempId = tempId
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

      // Check if this step has any trigger tools to determine if it should be manual
      const nodeTools = node.data?.tools || []
      const hasTriggerTool = nodeTools.some((tool: any) => tool.type === ToolType.TRIGGER)
      const hasFormTool = nodeTools.some((tool: any) => tool.type === ToolType.FORM)
      const hasReviewTool = nodeTools.some((tool: any) => tool.type === ToolType.REVIEW)
      
      // Determine step type: manual if it has trigger/form/review tools or is explicitly marked as manual
      const isManualStep = hasTriggerTool || hasFormTool || hasReviewTool || 
                          stepData.type === "form_submission" || 
                          stepData.type === "manual"

      const [createdStep] = await db
        .insert(workflowStepTemplate)
        .values({
          workflowTemplateId: templateId,
          name: stepData.name,
          description: stepData.description || "",
          type: isManualStep ? "manual" : "automated",
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
            // Tool has an ID and we have a mapping
            const backendId = toolIdMap.get(tool.id)!
            stepToolIds.push(backendId)
          } else {
            // Try to find by temporary ID for tools without frontend IDs
            const tempId = `${tool.type}_${JSON.stringify(tool.value || {}).slice(0, 50)}`
            
            if (toolIdMap.has(tempId)) {
              const backendId = toolIdMap.get(tempId)!
              stepToolIds.push(backendId)
            } else {
              // Fallback: Find tool by exact type and value match
              const matchingTool = createdTools.find(t => 
                t.type === tool.type && 
                JSON.stringify(t.value) === JSON.stringify(tool.value || {})
              )
              if (matchingTool) {
                stepToolIds.push(matchingTool.id)
              } else {
              }
            }
          }
        }
      }
      

      // Update the step with relationships
      const updateData = {
        prevStepIds,
        nextStepIds,
        toolIds: stepToolIds,
      }
      
      await db
        .update(workflowStepTemplate)
        .set(updateData)
        .where(eq(workflowStepTemplate.id, step.id))
        
    }

    // Third pass: Update review tool configs with backend step IDs
    for (const tool of createdTools) {
      if (tool.type === ToolType.REVIEW && tool.config) {
        const updatedConfig = { ...tool.config }
        let configChanged = false

        // Update approved step ID if it exists and maps to a backend step
        if (updatedConfig.approved && stepIdMap.has(updatedConfig.approved)) {
          updatedConfig.approved = stepIdMap.get(updatedConfig.approved)
          configChanged = true
        }

        // Update rejected step ID if it exists and maps to a backend step
        if (updatedConfig.rejected && stepIdMap.has(updatedConfig.rejected)) {
          updatedConfig.rejected = stepIdMap.get(updatedConfig.rejected)
          configChanged = true
        }

        // Only update if config changed
        if (configChanged) {
          await db
            .update(workflowTool)
            .set({ config: updatedConfig })
            .where(eq(workflowTool.id, tool.id))
          
          // Update the tool object for return data
          tool.config = updatedConfig
        }
      }
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

    // Re-query the updated steps from database to get correct toolIds
    const updatedSteps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, template.id))


    // Return the complete workflow template with steps and tools
    const completeTemplate = {
      ...template,
      rootWorkflowStepTemplateId: rootStepId,
      steps: updatedSteps,
      workflow_tools: createdTools,
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
    const requestData = await c.req.json()

    const [execution] = await db
      .insert(workflowExecution)
      .values({
        workflowTemplateId: requestData.workflowTemplateId,
        name: requestData.name,
        description: requestData.description,
        metadata: requestData.metadata || {},
        status: "draft",
        createdBy: "demo",
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
    const query = listWorkflowExecutionsQuerySchema.parse({
      id: c.req.query("id"),
      name: c.req.query("name"),
      from_date: c.req.query("from_date"),
      to_date: c.req.query("to_date"),
      limit: c.req.query("limit"),
      page: c.req.query("page"),
    })

    // Build where conditions
    const whereConditions = []

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
    const requestData = await c.req.json()

    const [tool] = await db
      .insert(workflowTool)
      .values({
        type: requestData.type,
        value: requestData.value,
        config: requestData.config || {},
        createdBy: "demo",
      })
      .returning()

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
    const toolId = c.req.param("toolId")
    const requestData = await c.req.json()

    // Check if tool exists first
    const existingTool = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolId))

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
    const toolId = c.req.param("toolId")

    const [tool] = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolId))

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
    const toolId = c.req.param("toolId")

    // Check if tool exists first
    const existingTool = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolId))

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
    const templateId = c.req.param("templateId")
    const requestData = await c.req.json()

    // Validate template exists
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

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
        value: requestData.tool.value,
        config: requestData.tool.config || {},
        createdBy: "api",
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
    python_script: "🐍",
    email: "📧",
    slack: "💬",
    gmail: "📮",
    delay: "⏰",
    agent: "🤖",
    merged_node: "🔀",
    review: "👁️",
  }
  return iconMap[toolType] || "⚙️"
}

// Delete workflow step template API
export const DeleteWorkflowStepTemplateApi = async (c: Context) => {
  try {
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
      .where(eq(workflowTemplate.id, templateId))

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

    // Get the current step execution
    const [currentStep] = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.id, stepId))

    if (!currentStep) {
      throw new HTTPException(404, {
        message: "Workflow step execution not found",
      })
    }

    // Check if all previous steps are completed
    const prevStepIds = currentStep.prevStepIds || []
    
    if (prevStepIds.length > 0) {
      // Get all step executions for this workflow
      const allSteps = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.workflowExecutionId, currentStep.workflowExecutionId))

      // Find previous steps and check their status
      const previousSteps = allSteps.filter(step => 
        prevStepIds.includes(step.workflowStepTemplateId)
      )

      const incompletePrevSteps = previousSteps.filter(step => 
        step.status !== WorkflowStatus.COMPLETED
      )

      if (incompletePrevSteps.length > 0) {
        const incompleteStepNames = incompletePrevSteps.map(step => step.name).join(", ")
        throw new HTTPException(400, {
          message: `Cannot complete step. Previous steps must be completed first: ${incompleteStepNames}`,
        })
      }
    }

    // All previous steps are completed, mark this step as complete
    const [stepExecution] = await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: "demo",
        completedAt: new Date(),
      })
      .where(eq(workflowStepExecution.id, stepId))
      .returning()

    // Update status of downstream steps that can now be activated
    await updateDownstreamStepStatuses(currentStep.workflowExecutionId)

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

// Review workflow step execution (approve/reject)
export const ReviewWorkflowStepApi = async (c: Context) => {
  try {
    const stepId = c.req.param("stepId")
    const requestData = await c.req.json()
    
    // Validate input
    if (!requestData.input || !["approved", "rejected"].includes(requestData.input)) {
      throw new HTTPException(400, {
        message: "Input must be either 'approved' or 'rejected'",
      })
    }

    const reviewDecision = requestData.input as "approved" | "rejected"

    // Get the current step execution
    const [currentStep] = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.id, stepId))

    if (!currentStep) {
      throw new HTTPException(404, {
        message: "Workflow step execution not found",
      })
    }

    // Get the step template to access tool configuration
    const stepTemplate = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, currentStep.workflowStepTemplateId))

    if (!stepTemplate || stepTemplate.length === 0) {
      throw new HTTPException(404, { message: "Step template not found" })
    }

    const toolIds = stepTemplate[0].toolIds || []
    if (toolIds.length === 0) {
      throw new HTTPException(400, {
        message: "No tools configured for this step",
      })
    }

    // Get the review tool
    const reviewTool = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolIds[0]))

    if (!reviewTool || reviewTool.length === 0) {
      throw new HTTPException(404, { message: "Review tool not found" })
    }

    if (reviewTool[0].type !== ToolType.REVIEW) {
      throw new HTTPException(400, {
        message: "Step is not a review step",
      })
    }

    // Get the next step template ID based on approval/rejection
    const toolConfig = reviewTool[0].config as any
    const nextStepTemplateId = reviewDecision === "approved" 
      ? toolConfig?.approved 
      : toolConfig?.rejected

    if (!nextStepTemplateId) {
      throw new HTTPException(400, {
        message: `No ${reviewDecision} step configured for this review`,
      })
    }

    // Get the single previous step that led to this review step
    const allWorkflowSteps = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, currentStep.workflowExecutionId))

    // Find the single previous step that has the current review step as its next step
    const previousStep = allWorkflowSteps.find(step => 
      step.nextStepIds?.includes(currentStep.workflowStepTemplateId) && 
      step.status === WorkflowStatus.COMPLETED
    )

    // Get previous step tool result
    let previousStepResult = null
    if (previousStep) {
      const allToolExecutions = await db
        .select()
        .from(toolExecution)
        .where(eq(toolExecution.workflowExecutionId, currentStep.workflowExecutionId))

      // Get the first tool execution result from the previous step
      const previousToolExec = allToolExecutions.find(te => 
        previousStep.toolExecIds?.includes(te.id)
      )
      
      if (previousToolExec) {
        previousStepResult = previousToolExec.result
      }
    }

    // Create tool execution record for the review decision
    const [toolExecutionRecord] = await db
      .insert(toolExecution)
      .values({
        workflowToolId: reviewTool[0].id,
        workflowExecutionId: currentStep.workflowExecutionId,
        status: ToolExecutionStatus.COMPLETED,
        result: {
          reviewDecision: reviewDecision,
          decidedAt: new Date().toISOString(),
          decidedBy: "demo",
          nextStepTemplateId: nextStepTemplateId,
          // Include previous step tool result so the next step can access the original input
          input: previousStepResult,
        },
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning()

    // Mark the review step as completed
    const [completedStep] = await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: "demo",
        completedAt: new Date(),
        toolExecIds: [toolExecutionRecord.id],
        metadata: {
          ...(currentStep.metadata || {}),
          reviewDecision: {
            decision: reviewDecision,
            decidedAt: new Date().toISOString(),
            decidedBy: "demo",
            nextStepTemplateId: nextStepTemplateId,
          },
        },
      })
      .where(eq(workflowStepExecution.id, stepId))
      .returning()

    // Update status of downstream steps that can now be activated
    await updateDownstreamStepStatuses(currentStep.workflowExecutionId)

    // Continue workflow execution - execute the next step based on decision
    const tools = await db.select().from(workflowTool)
    const stepName = currentStep.name || "Review Step"
    const currentResults: Record<string, any> = {}

    currentResults[stepName] = {
      stepId: currentStep.id,
      reviewDecision: {
        decision: reviewDecision,
        decidedAt: new Date().toISOString(),
        decidedBy: "demo",
        nextStepTemplateId: nextStepTemplateId,
      },
      toolExecution: toolExecutionRecord,
      // Include previous step tool result so the next step can access the original input
      previousStepResult: previousStepResult,
    }

    // Get all step executions for this workflow to find the next step
    const allSteps = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.workflowExecutionId, currentStep.workflowExecutionId))

    // Find the next step execution that matches the template ID
    const nextStep = allSteps.find(
      (s) => s.workflowStepTemplateId === nextStepTemplateId
    )

    if (nextStep && nextStep.type === StepType.AUTOMATED) {
      // Execute the next automated step
      executeWorkflowChain(
        currentStep.workflowExecutionId,
        nextStep.id,
        tools
      ).catch((error) => {
        Logger.error(
          error,
          `Background workflow execution failed after review decision`,
        )
      })
    }

    return c.json({
      success: true,
      message: `Review ${reviewDecision} successfully - workflow continued`,
      data: {
        stepId: stepId,
        reviewDecision: reviewDecision,
        nextStepTemplateId: nextStepTemplateId,
        toolExecution: toolExecutionRecord,
        completedStep: completedStep,
      },
    })
  } catch (error) {
    Logger.error(error, "Failed to process review decision")
    
    if (error instanceof HTTPException) {
      throw error
    }

    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

export const TriggerWorkflowStepApi = async (c: Context) => {
  try {
    const stepId = c.req.param("stepId")
    
    // Get JWT payload for user email
    let jwtPayload
    try {
      jwtPayload = c.get(JwtPayloadKey)
    } catch (e) {
      Logger.info("No JWT payload found in context")
    }

    const userEmail = jwtPayload?.sub
    if (!userEmail) {
      throw new HTTPException(401, { message: "Unauthorized - no user email" })
    }

    // Get the current step execution
    const [currentStep] = await db
      .select()
      .from(workflowStepExecution)
      .where(eq(workflowStepExecution.id, stepId))

    if (!currentStep) {
      throw new HTTPException(404, {
        message: "Workflow step execution not found",
      })
    }

    // Get the step template to access tool configuration
    const stepTemplate = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.id, currentStep.workflowStepTemplateId))

    if (!stepTemplate || stepTemplate.length === 0) {
      throw new HTTPException(404, { message: "Step template not found" })
    }

    const toolIds = stepTemplate[0].toolIds || []
    if (toolIds.length === 0) {
      throw new HTTPException(400, {
        message: "No tools configured for this step",
      })
    }

    // Get the trigger tool
    const triggerTool = await db
      .select()
      .from(workflowTool)
      .where(eq(workflowTool.id, toolIds[0]))

    if (!triggerTool || triggerTool.length === 0) {
      throw new HTTPException(404, { message: "Trigger tool not found" })
    }

    if (triggerTool[0].type !== ToolType.TRIGGER) {
      throw new HTTPException(400, {
        message: "Step is not a trigger step",
      })
    }

    // Create a tool execution record with triggered_by information
    const toolResult = {
      triggered_by: userEmail,
      triggered_at: new Date().toISOString(),
      message: "Trigger step completed successfully",
    }

    const [toolExecutionRecord] = await db
      .insert(toolExecution)
      .values({
        workflowToolId: triggerTool[0].id,
        workflowExecutionId: currentStep.workflowExecutionId,
        status: "completed",
        result: toolResult,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning()

    // Mark current step as completed
    const [completedStep] = await db
      .update(workflowStepExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedBy: userEmail,
        completedAt: new Date(),
        toolExecIds: [toolExecutionRecord.id],
        metadata: {
          ...(currentStep.metadata || {}),
          triggerCompletion: {
            triggeredBy: userEmail,
            triggeredAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(workflowStepExecution.id, stepId))
      .returning()

    // Update status of downstream steps that can now be activated
    await updateDownstreamStepStatuses(currentStep.workflowExecutionId)

    // Continue workflow execution with next steps
    const nextStepIds = currentStep.nextStepIds || []
    let executionResults = {}

    if (nextStepIds.length > 0) {
      // Get all step executions for this workflow to find the next steps
      const allSteps = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.workflowExecutionId, currentStep.workflowExecutionId))

      // Find and execute next steps
      for (const nextStepTemplateId of nextStepIds) {
        const nextStep = allSteps.find(step => 
          step.workflowStepTemplateId === nextStepTemplateId
        )
        
        if (nextStep && nextStep.type === StepType.AUTOMATED) {
          try {
            Logger.info(`🚀 Auto-executing next step after trigger: ${nextStep.name}`)
            executionResults = await executeWorkflowChain(
              currentStep.workflowExecutionId,
              nextStep.id,
              toolResult,
            )
          } catch (chainError) {
            Logger.error(`Failed to execute workflow chain from trigger step: ${chainError}`)
          }
        }
      }
    }

    return c.json({
      success: true,
      data: {
        stepId: stepId,
        triggeredBy: userEmail,
        toolExecution: toolExecutionRecord,
        completedStep: completedStep,
        executionResults,
      },
      message: "Trigger step completed successfully",
    })
  } catch (error) {
    Logger.error(error, "Failed to process trigger step")
    
    if (error instanceof HTTPException) {
      throw error
    }

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

// Download extracted files from workflow execution as ZIP
export const DownloadReviewFilesApi = async (c: Context) => {
  try {
    const { sub } = c.get(JwtPayloadKey)
    const executionId = c.req.param("executionId")

    if (!executionId) {
      throw new HTTPException(400, {
        message: "Execution ID is required",
      })
    }

    Logger.info(`Downloading extracted files for execution ${executionId}`)

    // Get workflow execution to verify user access
    const workflowExecutionRows = await db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))

    if (!workflowExecutionRows || workflowExecutionRows.length === 0) {
      throw new HTTPException(404, { message: "Workflow execution not found" })
    }

    const [workflow] = workflowExecutionRows

    // Debug logging
    Logger.info(`Download access check: executionId=${executionId}, user=${sub}, createdBy=${workflow.createdBy}`)

    // TODO: Re-enable access control in production
    // Temporarily allow any user to access files for development/testing
    // if (workflow.createdBy !== sub) {
    //   Logger.warn(`Access denied: user ${sub} tried to access workflow execution ${executionId} created by ${workflow.createdBy}`)
    //   throw new HTTPException(403, {
    //     message: "Access denied to this workflow execution",
    //   })
    // }

    // Get all tool executions for this workflow to find extracted files
    const toolExecutions = await db
      .select()
      .from(toolExecution)
      .where(eq(toolExecution.workflowExecutionId, executionId))

    // Collect all extracted files from all tool executions
    let allExtractedFiles: string[] = []
    for (const toolExecution of toolExecutions) {
      try {
        const result = toolExecution.result as any
        if (result?.extractedFiles && Array.isArray(result.extractedFiles)) {
          allExtractedFiles.push(...result.extractedFiles)
          Logger.info(`Found ${result.extractedFiles.length} files from tool execution ${toolExecution.id}`)
        }
      } catch (error) {
        Logger.error(error, `Failed to parse tool execution result for ${toolExecution.id}`)
      }
    }

    if (allExtractedFiles.length === 0) {
      throw new HTTPException(404, {
        message: "No extracted files found in this workflow execution",
      })
    }

    Logger.info(`Found ${allExtractedFiles.length} total extracted files available`)

    // Determine which files to download
    let filesToDownload: string[] = []
    
    if (c.req.method === 'POST') {
      // For POST requests, get specific files from request body
      const body = await c.req.json().catch(() => ({}))
      const requestedFiles = body.files || []
      
      if (!Array.isArray(requestedFiles)) {
        throw new HTTPException(400, {
          message: "Invalid request: 'files' must be an array of filenames",
        })
      }

      if (requestedFiles.length === 0) {
        throw new HTTPException(400, {
          message: "Invalid request: at least one file must be specified",
        })
      }

      // Validate that all requested files exist in extracted files
      const invalidFiles = requestedFiles.filter(file => !allExtractedFiles.includes(file))
      if (invalidFiles.length > 0) {
        throw new HTTPException(400, {
          message: `Requested files not found: ${invalidFiles.join(', ')}. Available files: ${allExtractedFiles.join(', ')}`,
        })
      }

      filesToDownload = requestedFiles
      Logger.info(`Downloading ${filesToDownload.length} specific files: ${JSON.stringify(filesToDownload)}`)
    } else {
      // For GET requests, download all files (backward compatibility)
      filesToDownload = allExtractedFiles
      Logger.info(`Downloading all ${filesToDownload.length} extracted files`)
    }

    // Create ZIP archive
    const zip = new JSZip()
    
    // Use the correct directory structure as mentioned by user
    const baseDir = path.resolve(process.cwd(), "script_executor_utils","workflow_files", executionId)
    
    let filesAdded = 0
    const errors: string[] = []

    Logger.info(`Looking for files in directory: ${baseDir}`)
    Logger.info(`Files to process: ${JSON.stringify(filesToDownload)}`)

    // Add each file to the ZIP
    for (const filePath of filesToDownload) {
      try {
        let fullPath: string
        
        // Handle both absolute and relative paths
        if (path.isAbsolute(filePath)) {
          // If it's an absolute path, use it directly but verify it's safe
          fullPath = filePath
          // Ensure the absolute path is within a reasonable scope
          if (!fullPath.includes(executionId)) {
            errors.push(`Skipped potentially unsafe absolute path: ${filePath}`)
            continue
          }
        } else {
          // If it's a relative path, join with base directory
          const safePath = path.normalize(filePath)
          if (safePath.includes("..")) {
            errors.push(`Skipped unsafe relative path: ${filePath}`)
            continue
          }
          fullPath = path.join(baseDir, safePath)
        }

        Logger.info(`Attempting to read file: ${fullPath}`)

        // Read file and add to ZIP
        const fileBuffer = await readFile(fullPath)
        const fileName = path.basename(filePath)
        
        // Add file to ZIP with buffer
        zip.file(fileName, fileBuffer, { binary: true })
        filesAdded++
        
        Logger.info(`Successfully added file to ZIP: ${fileName} (${fileBuffer.length} bytes)`)
      } catch (error) {
        Logger.error(error, `Failed to read file: ${filePath}`)
        errors.push(`Failed to read file: ${filePath} - ${error}`)
      }
    }

    if (filesAdded === 0) {
      throw new HTTPException(404, {
        message: `No files could be read from the filesystem. Errors: ${errors.join('; ')}`,
      })
    }

    Logger.info(`Creating ZIP with ${filesAdded} files`)

    // Test if ZIP has any files
    const fileNames = Object.keys(zip.files)
    Logger.info(`ZIP contains files: ${JSON.stringify(fileNames)}`)

    if (fileNames.length === 0) {
      throw new HTTPException(500, {
        message: "ZIP archive is empty after processing files"
      })
    }

    // Generate ZIP buffer with proper options
    const zipBuffer = await zip.generateAsync({ 
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    })

    Logger.info(`ZIP buffer generated, size: ${zipBuffer.length} bytes`)
    
    // Set response headers for file download
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-")
    const filename = `review-files-${executionId}-${timestamp}.zip`
    
    // Clear any existing headers that might interfere
    c.header("Content-Type", "application/zip")
    c.header("Content-Disposition", `attachment; filename="${filename}"`)
    c.header("Content-Length", zipBuffer.length.toString())
    c.header("Cache-Control", "no-cache")
    c.header("Pragma", "no-cache")

    Logger.info(`Successfully created ZIP with ${filesAdded} files (${errors.length} errors), size: ${zipBuffer.length} bytes`)

    // Return the ZIP file as a proper Response
    return new Response(zipBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": zipBuffer.length.toString(),
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    })
  } catch (error) {
    Logger.error(error, "Failed to download review files")
    throw error
  }
}
