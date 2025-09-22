
import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { WorkflowStatus, StepType, ToolType, ToolExecutionStatus } from "@/types/workflowTypes"

// Schema for workflow executions query parameters
const listWorkflowExecutionsQuerySchema = z.object({
  id: z.coerce.number().int().optional(),
  name: z.string().optional(),
  from_date: z.string().optional(), // ISO date string
  to_date: z.string().optional(), // ISO date string
  limit: z.coerce.number().min(1).max(100).optional().default(10),
  page: z.coerce.number().min(1).optional().default(1),
})
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { db } from "@/db/client"
import {
  workflowTemplate,
  workflowStepTemplate,
  workflowExe,
  workflowStepExe,
  workflowTool,
  workflowToolExe,
  workflowStepTemplateConnection,
  workflowStepExeConnection,
  workflowServiceConfig,
  createWorkflowTemplateSchema,
  createComplexWorkflowTemplateSchema,
  createWorkflowToolSchema,
  executeWorkflowSchema,
  updateWorkflowTemplateSchema,
  createWorkflowExecutionSchema,
  updateWorkflowExecutionSchema,
  updateWorkflowStepExecutionSchema,
  formSubmissionSchema,
  // Legacy aliases for compatibility
  workflowExe as workflowExecution,
  workflowStepExe as workflowStepExecution,
  workflowToolExe as toolExecution,
} from "@/db/schema/workflows"
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
import { getWorkspaceByExternalId } from "@/db/workspace"
import { handleAttachmentUpload } from "@/api/files"
import {
  handleWorkflowFileUpload,
  validateFormData,
  buildValidationSchema,
  type WorkflowFileUpload,
} from "@/api/workflowFileHandler"
import { getActualNameFromEnum } from "@/ai/modelConfig"
import { getProviderByModel } from "@/ai/provider"
import { Models } from "@/ai/types"
import type { Message } from "@aws-sdk/client-bedrock-runtime"

const loggerWithChild = getLoggerWithChild(Subsystem.WorkflowApi)
const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.WorkflowApi)

// Helper functions for step relationship management

/**
 * Convert numeric IDs to strings for frontend compatibility
 */
function convertIdsToStrings(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(convertIdsToStrings)
  }
  if (obj !== null && typeof obj === 'object') {
    const converted: any = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key.endsWith('Id') || key.endsWith('Ids') || key === 'id') {
        if (Array.isArray(value)) {
          converted[key] = value.map(v => String(v))
        } else if (value !== null && value !== undefined) {
          converted[key] = String(value)
        } else {
          converted[key] = value
        }
      } else {
        converted[key] = convertIdsToStrings(value)
      }
    }
    return converted
  }
  return obj
}

/**
 * Get next step templates from connection table
 */
async function getNextStepTemplates(stepTemplateId: number): Promise<number[]> {
  const connections = await db
    .select({ toStepId: workflowStepTemplateConnection.toStepId })
    .from(workflowStepTemplateConnection)
    .where(
      and(
        eq(workflowStepTemplateConnection.fromStepId, stepTemplateId),
        eq(workflowStepTemplateConnection.relationType, "NEXT")
      )
    )
  return connections.map(c => c.toStepId)
}

/**
 * Get previous step templates from connection table
 */
async function getPreviousStepTemplates(stepTemplateId: number): Promise<number[]> {
  const connections = await db
    .select({ fromStepId: workflowStepTemplateConnection.fromStepId })
    .from(workflowStepTemplateConnection)
    .where(
      and(
        eq(workflowStepTemplateConnection.toStepId, stepTemplateId),
        eq(workflowStepTemplateConnection.relationType, "NEXT")
      )
    )
  return connections.map(c => c.fromStepId)
}

/**
 * Get next step executions from connection table
 */
async function getNextStepExecutions(stepExeId: number): Promise<number[]> {
  const connections = await db
    .select({ toStepId: workflowStepExeConnection.toStepId })
    .from(workflowStepExeConnection)
    .where(
      and(
        eq(workflowStepExeConnection.fromStepId, stepExeId),
        eq(workflowStepExeConnection.relationType, "NEXT")
      )
    )
  return connections.map(c => c.toStepId)
}

/**
 * Get previous step executions from connection table
 */
async function getPreviousStepExecutions(stepExeId: number): Promise<number[]> {
  const connections = await db
    .select({ fromStepId: workflowStepExeConnection.fromStepId })
    .from(workflowStepExeConnection)
    .where(
      and(
        eq(workflowStepExeConnection.toStepId, stepExeId),
        eq(workflowStepExeConnection.relationType, "NEXT")
      )
    )
  return connections.map(c => c.fromStepId)
}

/**
 * Create a connection between two step templates
 */
async function createStepTemplateConnection(fromStepId: number, toStepId: number) {
  await db
    .insert(workflowStepTemplateConnection)
    .values({
      fromStepId,
      toStepId,
      relationType: "NEXT",
      connectionConfig: {}
    })
}

/**
 * Create a connection between two step executions
 */
async function createStepExecutionConnection(fromStepId: number, toStepId: number) {
  await db
    .insert(workflowStepExeConnection)
    .values({
      fromStepId,
      toStepId,
      relationType: "NEXT",
      connectionConfig: {}
    })
}

/**
 * Find root step template (step with no incoming connections)
 */
async function findRootStepTemplate(workflowTemplateId: number): Promise<number | null> {
  const allSteps = await db
    .select({ id: workflowStepTemplate.id })
    .from(workflowStepTemplate)
    .where(eq(workflowStepTemplate.workflowTemplateId, workflowTemplateId))

  for (const step of allSteps) {
    const previousSteps = await getPreviousStepTemplates(step.id)
    if (previousSteps.length === 0) {
      return step.id
    }
  }

  // Fallback to first step if no clear root found
  return allSteps.length > 0 ? allSteps[0].id : null
}

/**
 * Find root step execution (step with no incoming connections)
 */
async function findRootStepExecution(workflowExeId: number): Promise<number | null> {
  const allSteps = await db
    .select({ id: workflowStepExe.id })
    .from(workflowStepExe)
    .where(eq(workflowStepExe.workflowExeId, workflowExeId))

  for (const step of allSteps) {
    const previousSteps = await getPreviousStepExecutions(step.id)
    if (previousSteps.length === 0) {
      return step.id
    }
  }

  // Fallback to first step if no clear root found
  return allSteps.length > 0 ? allSteps[0].id : null
}

/**
 * Delete all connections involving a step template
 */
async function deleteStepTemplateConnections(stepTemplateId: number) {
  await db
    .delete(workflowStepTemplateConnection)
    .where(
      or(
        eq(workflowStepTemplateConnection.fromStepId, stepTemplateId),
        eq(workflowStepTemplateConnection.toStepId, stepTemplateId)
      )
    )
}

/**
 * Delete all connections involving a step execution
 */
async function deleteStepExecutionConnections(stepExeId: number) {
  await db
    .delete(workflowStepExeConnection)
    .where(
      or(
        eq(workflowStepExeConnection.fromStepId, stepExeId),
        eq(workflowStepExeConnection.toStepId, stepExeId)
      )
    )
}

/**
 * Compute step relationships for frontend compatibility
 * Returns parentStepId, nextStepIds, prevStepIds based on connection tables
 */
// WF FIX: This function is called inside loops in `ListWorkflowTemplatesApi` and `GetWorkflowExecutionApi`,
// causing an N+1 query problem. Each call to `getNextSteps` and `getPrevSteps` results in a database query.
// A better approach is to fetch all connections for the workflow at once and build in-memory maps for lookups.
async function computeStepRelationships(stepId: number, isTemplate: boolean = true) {
  const getNextSteps = isTemplate ? getNextStepTemplates : getNextStepExecutions
  const getPrevSteps = isTemplate ? getPreviousStepTemplates : getPreviousStepExecutions

  const nextStepIds = await getNextSteps(stepId)
  const prevStepIds = await getPrevSteps(stepId)

  // For parentStepId, use the first previous step (assuming single parent for simplicity)
  // In more complex workflows, this might need different logic
  const parentStepId = prevStepIds.length > 0 ? prevStepIds[0] : null

  return {
    parentStepId,
    nextStepIds,
    prevStepIds
  }
}

/**
 * Enhance step template with computed relationship fields
 */
async function enhanceStepTemplateWithRelationships(step: any) {
  const relationships = await computeStepRelationships(step.id, true)
  return {
    ...step,
    parentStepId: relationships.parentStepId,
    nextStepIds: relationships.nextStepIds,
    prevStepIds: relationships.prevStepIds
  }
}

/**
 * Enhance step execution with computed relationship fields
 */
async function enhanceStepExecutionWithRelationships(step: any) {
  const relationships = await computeStepRelationships(step.id, false)
  return {
    ...step,
    parentStepId: relationships.parentStepId,
    nextStepIds: relationships.nextStepIds,
    prevStepIds: relationships.prevStepIds
  }
}

// New Workflow API Routes
export const workflowRouter = new Hono()

// WF FIX: Find userId and workspaceId from JWT in each api
// List all workflow templates with root step details
export const ListWorkflowTemplatesApi = async (c: Context) => {
  try {
    // WF FIX: Add where clause on workspaceId
    const templates = await db.select().from(workflowTemplate)

    // Get step templates and root step details for each workflow
    // WF FIX: We can return templates itself to frontend?
    // When user selects a template, we can call GetWorkflowTemplateApi
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

            // Enhance root step with computed relationship fields
            // WF FIX: This function causes an N+1 query problem. It's called for every step,
            // and each call makes two separate database queries.
            // A better approach would be to fetch all workflowStepTemplateConnection using templateId,
            // build in-memory maps for next/previous steps, and then use those maps
            // to look up relationships, avoiding multiple database calls in a loop.
            const enhancedRootStep = await enhanceStepTemplateWithRelationships(rootStepResult)

            rootStep = {
              ...enhancedRootStep,
              tool: rootStepTool,
            }
          }
        }

        return {
          ...template,
          config: template.config || {},
          rootStep,
        }
      }),
    )

    return c.json({
      success: true,
      data: convertIdsToStrings(templatesWithSteps),
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
    const templateId = parseInt(c.req.param("templateId"), 10)

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

    // Enhance steps with computed relationship fields
    const stepsWithRelationships = await Promise.all(
      steps.map(step => enhanceStepTemplateWithRelationships(step))
    )

    const toolIds = steps.flatMap((s) => s.toolIds || [])
    const tools =
      toolIds.length > 0
        ? await db
            .select()
            .from(workflowTool)
            .where(inArray(workflowTool.id, toolIds))
        : []

    const responseData = {
      ...template[0],
      config: template[0].config || {},
      steps: stepsWithRelationships,
      workflow_tools: tools,
    }

    return c.json({
      success: true,
      data: convertIdsToStrings(responseData),
    })
  } catch (error) {
    Logger.error(error, "Failed to get workflow template")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Execute workflow template with root step input
// WF FIX: The execution flow is complex and could be simplified.
// ExecuteWorkflowWithInputApi -> executeAutomatedWorkflowStepsById -> executeWorkflowChain (which is recursive).
// This is redundant. The recursion in `executeWorkflowChain` should be sufficient,
// and the intermediate `executeAutomatedWorkflowStepsById` function could be removed.
export const ExecuteWorkflowWithInputApi = async (c: Context) => {
  try {
    // Parse templateId from URL and get content type from header
    const templateId = parseInt(c.req.param("templateId"), 10)
    const contentType = c.req.header("content-type") || ""

    // Extract workspace external ID from JWT payload for authorization
    const { workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)

    // Retrieve the internal integer workspace ID from the external ID
    const workspace = await getWorkspaceByExternalId(db, workspaceExternalId)
    if (!workspace) {
      throw new HTTPException(404, { message: "Workspace not found" })
    }
    const workspaceId = workspace.id

    let requestData: any = {}
    let hasFileUploads = false

    // WF FIX: Refactor request parsing logic into its own function, e.g., parseWorkflowInput(c: Context)
    // Handle both JSON and multipart/form-data content types
    if (contentType.includes("multipart/form-data")) {
      // For multipart, parse form data to handle file uploads and fields
      const formData = await c.req.formData()
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
          // Store file object for later processing after validation
          requestData.rootStepInput[key] = value
          hasFileUploads = true
        }
      }
    } else {
      // For JSON, parse the request body directly
      requestData = await c.req.json()
    }

    // Ensure that rootStepInput is provided in the request
    if (!requestData.rootStepInput) {
      throw new HTTPException(400, { message: "rootStepInput is required" })
    }

    // Fetch the workflow template from the database
    const template = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))

    // Validate that the template exists and has a configured root step
    if (!template || template.length === 0) {
      throw new HTTPException(404, { message: "Workflow template not found" })
    }

    if (!template[0].rootWorkflowStepTemplateId) {
      throw new HTTPException(400, {
        message: "Template has no root step configured",
      })
    }

    // Fetch the root step template for validation and processing
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

    // Fetch the tool associated with the root step for input validation
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

    // WF FIX: Refactor input validation logic into its own function, e.g., validateRootStepInput(rootStep, rootStepTool, inputData, contentType)
    // Validate the input based on the root step's type (MANUAL/FORM vs. AUTOMATED)
    if (rootStep.type === StepType.MANUAL && rootStepTool?.type === ToolType.FORM) {
      // For manual form steps, validate the submitted form data
      const formDefinition = (rootStepTool.config as any)?.value || rootStepTool.config as any
      const formFields = formDefinition?.fields || []

      // Build a dynamic validation schema from the form definition
      const validationSchema = buildValidationSchema(formFields)

      // If the request is multipart, handle file and non-file fields separately
      if (contentType.includes("multipart/form-data")) {
        // First, validate only the non-file fields
        const nonFileData = { ...requestData.rootStepInput }
        const nonFileValidationSchema = { ...validationSchema }

        // Remove file fields from the initial validation schema
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

        // Temporarily store file objects for processing after the execution is created
        for (const field of formFields) {
          if (field.type === "file") {
            const file = requestData.rootStepInput[field.id]

            if (file instanceof File) {
              try {
                // Store the file object for later upload
                requestData.rootStepInput[field.id] = file
              } catch (uploadError) {
                Logger.error(
                  uploadError,
                  `File validation failed for field ${field.id}`,
                )
                throw new HTTPException(400, {
                  message: `File validation failed for ${field.id}: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
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
        // For JSON requests, validate the entire form data at once
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
      // For automated steps, ensure no input data is provided
      if (Object.keys(requestData.rootStepInput).length > 0) {
        throw new HTTPException(400, {
          message: "Automated root steps should not have input data",
        })
      }
    }

    // Create the main workflow execution record
    const [execution] = await db
      .insert(workflowExe)
      .values({
        workflowTemplateId: template[0].id,
        // WF FIX: Using toLocaleDateString() can lead to duplicate names if the same workflow is run multiple times on the same day.
        // Consider using a more unique timestamp, like toISOString(), to ensure uniqueness.
        name:
          requestData.name ||
          `${template[0].name} - ${new Date().toLocaleDateString()}`,
        description:
          requestData.description || `Execution of ${template[0].name}`,
        metadata: requestData.metadata || {},
        status: "active",
        workspaceId: workspaceId, // Associate with the user's workspace
        rootWorkflowStepExeId: sql`NULL`, // To be updated after step executions are created
      })
      .returning()

    // Fetch all step templates associated with the workflow
    // WF FIX: Use proper name for variables, can we use workflowTemplateSteps
    // Should we also change the table names to workflow_template_step etc
    // That way the singular / plural variable names can be handled better
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    // Create execution records for all steps in the template with a "pending" status
    const stepExecutionsData = steps.map((step) => ({
      workflowExeId: execution.id,
      workflowStepTemplateId: step.id,
      name: step.name,
      type: step.type,
      status: "pending" as const,
      toolIds: step.toolIds || [],
      timeEstimate: step.timeEstimate,
      metadata: step.metadata,
    }))

    const stepExecutions = await db
      .insert(workflowStepExe)
      .values(stepExecutionsData)
      .returning()

    // Replicate the template's step connections for this specific execution
    Logger.info(`📋 Creating execution connections based on template connections...`)

    const stepIds = steps.map(s => s.id)
    // WF FIX: Lets add workflowTemplateId to workflowStepTemplateConnection table
    // and we can then query directly on workflowTemplateId itself
    const templateConnections = await db
      .select()
      .from(workflowStepTemplateConnection)
      .where(or(
        inArray(workflowStepTemplateConnection.fromStepId, stepIds),
        inArray(workflowStepTemplateConnection.toStepId, stepIds)
      ))

    Logger.info(`🔗 Found ${templateConnections.length} template connections to copy`)

    // Create new connections in the execution connection table
    // WF FIX: Refactor this loop.
    // 1. Instead of awaiting in the loop, build an array of `executionConnectionsData`.
    // 2. Perform a single bulk `db.insert().values()` after the loop.
    // 3. Simultaneously, populate an in-memory `executionConnectionMap<number, number[]>` to map fromStepId to toStepId(s).
    for (const templateConnection of templateConnections) {
      const fromStepExecution = stepExecutions.find(se => se.workflowStepTemplateId === templateConnection.fromStepId)
      const toStepExecution = stepExecutions.find(se => se.workflowStepTemplateId === templateConnection.toStepId)

      if (fromStepExecution && toStepExecution) {
        await createStepExecutionConnection(fromStepExecution.id, toStepExecution.id)
        Logger.info(`✅ Created execution connection: ${fromStepExecution.id} -> ${toStepExecution.id}`)
      }
    }

    // Identify the root step execution based on the template's root step ID
    const rootStepExecution = stepExecutions.find(
      (se: any) =>
        se.workflowStepTemplateId === template[0].rootWorkflowStepTemplateId,
    )

    if (!rootStepExecution) {
      throw new HTTPException(500, {
        message: "Failed to create root step execution",
      })
    }

    // Update the main workflow execution with the ID of the root step execution
    await db
      .update(workflowExe)
      .set({ rootWorkflowStepExeId: rootStepExecution.id })
      .where(eq(workflowExe.id, execution.id))

    // Process file uploads and create a tool execution record for the root step
    let toolExecutionRecord = null
    let processedFormData = { ...requestData.rootStepInput }

    if (rootStepTool) {
      // If the request was multipart and the tool is a form, handle file uploads
      if (
        contentType.includes("multipart/form-data") &&
        rootStepTool.type === ToolType.FORM
      ) {
        const formDefinition = (rootStepTool.config as any)?.value || rootStepTool.config as any
        const formFields = formDefinition?.fields || []

        // Process and upload each file
        for (const field of formFields) {
          if (field.type === "file") {
            const file = requestData.rootStepInput[field.id]

            if (file instanceof File) {
              try {
                const fileValidation =
                  buildValidationSchema(formFields)[field.id]?.fileValidation

                const uploadedFile = await handleWorkflowFileUpload(
                  file,
                  execution.id.toString(),
                  rootStepExecution.id.toString(),
                  fileValidation,
                )

                // Replace the file object with the upload result in the form data
                processedFormData[field.id] = uploadedFile
                Logger.info(
                  `File uploaded for field ${field.id}: ${uploadedFile.relativePath}`,
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
            }
          }
        }
      }
      // Create a tool execution record to log the form submission
      ;[toolExecutionRecord] = await db
        .insert(workflowToolExe)
        .values({
          toolId: rootStepTool.id,
          result: {
            formData: processedFormData,
            submittedAt: new Date().toISOString(),
            submittedBy: "api",
            autoCompleted: true,
          },
          completedAt: new Date(),
        })
        .returning()
    }

    // Mark the root step execution as "done"
    await db
      .update(workflowStepExe)
      .set({
        status: "done",
        completedBy: null,
        completedAt: new Date(),
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
      .where(eq(workflowStepExe.id, rootStepExecution.id))

    // Prepare to trigger subsequent automated steps
    // WF FIX: This fetches all tools from the database, which is inefficient. It should be optimized
    // to only fetch the tools relevant to the step templates of this specific workflow.
    const allTools = await db.select().from(workflowTool)
    const rootStepName = rootStepExecution.name || "Root Step"
    const currentResults: Record<string, any> = {}

    // Store the results of the root step for subsequent steps to access
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

    // Immediately return a response to the client while automated steps run in the background
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

    // Trigger the execution of the next automated steps in a non-blocking manner
    try {
      Logger.info(`🔄 Starting automated step execution for workflow ${execution.id}`)
      Logger.info(`📋 Root step execution: ${JSON.stringify(rootStepExecution)}`)

      if (!rootStepExecution.workflowStepTemplateId) {
        Logger.warn("❌ Root step execution has no template ID, skipping automated execution")
        // WF FIX: Should we update workflow exe status before returning response
        return c.json(responseData)
      }

      // Get the next step execution IDs from the connection table
      Logger.info(`🔍 Looking for next steps after root step execution ID: ${rootStepExecution.id}`)
      // WF FIX: Replace this database call by using the in-memory `executionConnectionMap` created during the connection-building step.
      // const nextStepExecutionIds = executionConnectionMap.get(rootStepExecution.id) || [];
      const nextStepExecutionIds = await getNextStepExecutions(rootStepExecution.id)
      Logger.info(`📝 Found next step execution IDs: ${JSON.stringify(nextStepExecutionIds)}`)

      if (nextStepExecutionIds.length > 0) {
        Logger.info(`✅ Found ${nextStepExecutionIds.length} next steps to execute`)

        // WF FIX: This is redundant. The `stepExecutions` object from the `.returning()` call earlier contains the same data.
        // Pass the `stepExecutions` object directly to the background process instead of re-querying the database.
        const allStepExecutions = await db
          .select()
          .from(workflowStepExe)
          .where(eq(workflowStepExe.workflowExeId, execution.id))

        Logger.info(`📊 Total step executions: ${allStepExecutions.length}`)
        Logger.info(`🎯 Current results for background execution: ${JSON.stringify(currentResults)}`)

        // Use setImmediate to run the automated steps in the background
        Logger.info(`🚀 Starting background execution with setImmediate...`)
        setImmediate(async () => {
          try {
            Logger.info(`🔥 BACKGROUND: Starting executeAutomatedWorkflowSteps for workflow ${execution.id}`)
            await executeAutomatedWorkflowStepsById(
              execution.id.toString(),
              nextStepExecutionIds.map(id => id.toString()),
              allStepExecutions,
              allTools,
              currentResults
            )
            Logger.info(`✨ BACKGROUND: Completed executeAutomatedWorkflowSteps for workflow ${execution.id}`)
          } catch (bgError) {
            Logger.error(bgError, "❌ BACKGROUND: Background workflow execution failed")
          }
        })
      } else {
        // If there are no next steps, mark the workflow as completed
        Logger.info("❌ No next steps found, workflow execution complete")
        await db
          .update(workflowExe)
          .set({
            status: ToolExecutionStatus.COMPLETED,
            completedAt: new Date(),
          })
          .where(eq(workflowExe.id, execution.id))
      }
    } catch (stepError) {
      Logger.error(stepError, "Failed to execute next steps")
    }

    // Return the initial success response
    return c.json(responseData)
  } catch (error) {
    Logger.error(error, "Failed to execute workflow with input")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

// Execute workflow template
// WF FIX: Rename this api, as this executes a workflow
export const ExecuteWorkflowTemplateApi = async (c: Context) => {
  try {
    const templateId = parseInt(c.req.param("templateId"), 10)
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
    // WF FIX: This fetches all tools from the database. It should be optimized to only fetch the tools
    // relevant to the specific workflow template being executed.
    const tools = await db.select().from(workflowTool)

    // Create workflow execution
    const [execution] = await db
      .insert(workflowExe)
      .values({
        workflowTemplateId: template[0].id,
        name:
          requestData.name ||
          `${template[0].name} - ${new Date().toLocaleDateString()}`,
        description:
          requestData.description || `Execution of ${template[0].name}`,
        metadata: requestData.metadata || {},
        status: "active",
        workspaceId: 1, // Default integer workspace ID
        rootWorkflowStepExeId: null,
      })
      .returning()

    // Create step executions for all template steps
    const stepExecutionsData = steps.map((step) => ({
      workflowExeId: execution.id,
      workflowStepTemplateId: step.id,
      name: step.name,
      type: step.type,
      status: "pending" as const,
      // Copy tool IDs from step template
      toolIds: step.toolIds || [],
      timeEstimate: step.timeEstimate,
      metadata: step.metadata,
    }))

    const stepExecutions = await db
      .insert(workflowStepExe)
      .values(stepExecutionsData)
      .returning()

    // Find root step (no parent)
    // Find root step (first step with no incoming connections)
    // For now, use the first step as root - connection logic will be added later
    const rootStepExecution = stepExecutions[0]

    if (rootStepExecution) {
      await db
        .update(workflowExe)
        .set({ rootWorkflowStepExeId: rootStepExecution.id })
        .where(eq(workflowExe.id, execution.id))
    }

    // Auto-execute workflow starting from root step if it's automated
    let executionResults = {}

    if (rootStepExecution && rootStepExecution.type === StepType.AUTOMATED) {
      executionResults = await executeWorkflowChain(
        execution.id.toString(),
        rootStepExecution.id.toString(),
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
      .from(workflowExe)
      .where(eq(workflowExe.id, parseInt(executionId, 10)))

    if (!currentExecution || currentExecution.status === "completed" || currentExecution.status === "active") {
      return false // Already completed or failed, no update needed
    }

    // Get all step executions for this workflow
    const allStepExecutions = await db
      .select()
      .from(workflowStepExe)
      .where(eq(workflowStepExe.workflowExeId, parseInt(executionId, 10)))

    // Filter steps that are part of the actual execution path
    // A step is considered "in execution path" if:
    // 1. It has been started (status is not "draft")
    // 2. OR it's the root step
    // 3. OR it has completed tool executions
    const executedSteps = allStepExecutions.filter(step => {
      const isRootStep = currentExecution.rootWorkflowStepExeId === step.id
      const hasBeenStarted = step.status !== "pending"
      const hasToolExecutions = step.toolIds && step.toolIds.length > 0
      
      return isRootStep || hasBeenStarted || hasToolExecutions
    })

    Logger.info(
      `Workflow ${executionId}: ${executedSteps.length} executed steps out of ${allStepExecutions.length} total steps`
    )

    // Check completion conditions
    const completedSteps = executedSteps.filter(step => step.status === "done")
    const blockedSteps = executedSteps.filter(step => step.status === "blocked")
    const pendingSteps = executedSteps.filter(step => step.status === "pending")
    const manualStepsAwaitingInput = executedSteps.filter(step => 
      step.type === "manual" && step.status === "pending"
    )

    Logger.info(
      `Workflow ${executionId} status: ${completedSteps.length} completed, ${blockedSteps.length} blocked, ${pendingSteps.length} pending, ${manualStepsAwaitingInput.length} awaiting input`
    )

    // Update workflow metadata with execution progress
    const progressMetadata = {
      ...(currentExecution.metadata || {}),
      executionProgress: {
        totalSteps: allStepExecutions.length,
        executedSteps: executedSteps.length,
        completedSteps: completedSteps.length,
        blockedSteps: blockedSteps.length,
        pendingSteps: pendingSteps.length,
        manualStepsAwaitingInput: manualStepsAwaitingInput.length,
        lastUpdated: new Date().toISOString()
      }
    }

    // Determine if workflow should be marked as completed
    let shouldComplete = false
    let completionReason = ""

    if (blockedSteps.length > 0) {
      // If any executed step failed, mark workflow as failed
      await db
        .update(workflowExe)
        .set({
          status: "draft",
          completedAt: new Date(),
          metadata: progressMetadata
        })
        .where(eq(workflowExe.id, parseInt(executionId, 10)))
      
      Logger.info(`Workflow ${executionId} marked as failed due to ${blockedSteps.length} blocked steps`)
      return true
    }

    if (executedSteps.length === 0) {
      // No steps have been executed yet, workflow is not complete
      shouldComplete = false
    } else if (completedSteps.length === executedSteps.length) {
      // All executed steps are completed
      shouldComplete = true
      completionReason = "All executed steps completed"
    } else if (pendingSteps.length === 0 && manualStepsAwaitingInput.length === 0) {
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
      .update(workflowExe)
      .set({
        metadata: progressMetadata,
        updatedAt: new Date()
      })
      .where(eq(workflowExe.id, parseInt(executionId, 10)))

    if (shouldComplete) {
      Logger.info(
        `Workflow ${executionId} completion criteria met: ${completionReason}`
      )
      
      await db
        .update(workflowExe)
        .set({
          status: ToolExecutionStatus.COMPLETED,
          completedAt: new Date(),
          metadata: progressMetadata
        })
        .where(eq(workflowExe.id, parseInt(executionId, 10)))
      
      Logger.info(`Workflow ${executionId} marked as completed`)
      return true
    }

    return false
  } catch (error) {
    Logger.error(error, `Failed to check workflow completion for ${executionId}`)
    return false
  }
}

// Execute automated workflow steps in background using execution IDs
const executeAutomatedWorkflowStepsById = async (
  executionId: string,
  nextStepExecutionIds: string[],
  stepExecutions: any[],
  allTools: any[],
  currentResults: any,
) => {
  try {
    Logger.info(
      `🎬 Starting background execution of automated steps for workflow ${executionId} (by execution IDs)`,
    )
    Logger.info(`🎯 Target step execution IDs: ${JSON.stringify(nextStepExecutionIds)}`)
    Logger.info(`📋 Available step executions: ${stepExecutions.length}`)
    Logger.info(`🔧 Available tools: ${allTools.length}`)

    let executionResults = currentResults

    for (const nextStepExecutionId of nextStepExecutionIds) {
      Logger.info(`🔍 Looking for step execution with ID: ${nextStepExecutionId}`)

      const nextStep = stepExecutions.find(
        (s) => s.id === parseInt(nextStepExecutionId),
      )

      Logger.info(`📝 Step found: ${nextStep ? 'YES' : 'NO'}`)
      if (nextStep) {
        Logger.info(`📄 Step details: ${JSON.stringify(nextStep)}`)
      }

      if (nextStep && nextStep.type === StepType.AUTOMATED) {
        Logger.info(
          `🚀 Executing automated step: ${nextStep.name} (${nextStep.id})`,
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
      .from(workflowStepExe)
      .where(eq(workflowStepExe.workflowExeId, parseInt(executionId, 10)))

    const allStepsCompleted = updatedStepExecutions.every(
      (step) => step.status === "done",
    )

    if (allStepsCompleted) {
      Logger.info(
        `All steps completed for workflow execution ${executionId}, marking as completed`,
      )
      await db
        .update(workflowExe)
        .set({
          status: ToolExecutionStatus.COMPLETED,
          completedAt: new Date(),
        })
        .where(eq(workflowExe.id, parseInt(executionId, 10)))
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
        .from(workflowExe)
        .where(eq(workflowExe.id, parseInt(executionId, 10)))

      if (currentExecution && currentExecution.status !== "draft") {
        // Only mark as failed if not already failed (to avoid overriding specific failure info)
        await db
          .update(workflowExe)
          .set({
            status: "draft",
            completedAt: new Date(),
          })
          .where(eq(workflowExe.id, parseInt(executionId, 10)))
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

// Execute automated workflow steps in background (legacy template ID version)
const executeAutomatedWorkflowSteps = async (
  executionId: string,
  nextStepTemplateIds: string[],
  stepExecutions: any[],
  allTools: any[],
  currentResults: any,
) => {
  try {
    Logger.info(
      `🎬 Starting background execution of automated steps for workflow ${executionId}`,
    )
    Logger.info(`🎯 Target step template IDs: ${JSON.stringify(nextStepTemplateIds)}`)
    Logger.info(`📋 Available step executions: ${stepExecutions.length}`)
    Logger.info(`🔧 Available tools: ${allTools.length}`)

    let executionResults = currentResults

    for (const nextStepTemplateId of nextStepTemplateIds) {
      Logger.info(`🔍 Looking for step execution with template ID: ${nextStepTemplateId}`)

      const nextStep = stepExecutions.find(
        (s) => s.workflowStepTemplateId === parseInt(nextStepTemplateId),
      )

      Logger.info(`📝 Step found: ${nextStep ? 'YES' : 'NO'}`)
      if (nextStep) {
        Logger.info(`📄 Step details: ${JSON.stringify(nextStep)}`)
      }

      if (nextStep && nextStep.type === StepType.AUTOMATED) {
        Logger.info(
          `🚀 Executing automated step: ${nextStep.name} (${nextStep.id})`,
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
      .from(workflowStepExe)
      .where(eq(workflowStepExe.workflowExeId, parseInt(executionId, 10)))

    const allStepsCompleted = updatedStepExecutions.every(
      (step) => step.status === "done",
    )

    if (allStepsCompleted) {
      Logger.info(
        `All steps completed for workflow execution ${executionId}, marking as completed`,
      )
      await db
        .update(workflowExe)
        .set({
          status: ToolExecutionStatus.COMPLETED,
          completedAt: new Date(),
        })
        .where(eq(workflowExe.id, parseInt(executionId, 10)))
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
        .from(workflowExe)
        .where(eq(workflowExe.id, parseInt(executionId, 10)))

      if (currentExecution && currentExecution.status !== "draft") {
        // Only mark as failed if not already failed (to avoid overriding specific failure info)
        await db
          .update(workflowExe)
          .set({
            status: "draft",
            completedAt: new Date(),
          })
          .where(eq(workflowExe.id, parseInt(executionId, 10)))
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
const executeWorkflowChain = async (
  executionId: string,
  currentStepId: string,
  tools: any[],
  previousResults: any,
) => {
  try {
    // Get current step execution
    const stepExecution = await db
      .select()
      .from(workflowStepExe)
      .where(eq(workflowStepExe.id, parseInt(currentStepId, 10)))
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
      .where(step.workflowStepTemplateId ? eq(workflowStepTemplate.id, step.workflowStepTemplateId) : sql`false`)
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
      return previousResults
    }

    // Execute the tool
    const toolResult = await executeWorkflowTool(tool, previousResults)

    // Check if tool execution failed
    if (toolResult.status !== "success") {
      Logger.error(`Tool execution failed for step ${step.name}: ${JSON.stringify(toolResult.result)}`)
      
      // Create failed tool execution record
      let toolExecutionRecord
      try {
        const [execution] = await db
          .insert(workflowToolExe)
          .values({
            toolId: tool.id,
            result: toolResult.result,
          })
          .returning()
        toolExecutionRecord = execution
      } catch (dbError) {
        Logger.warn("Database insert failed for failed tool, creating minimal record:", dbError)
        const [execution] = await db
          .insert(workflowToolExe)
          .values({
            toolId: tool.id,
            result: {
              error: "Tool execution failed and result could not be stored",
              original_error: "Database storage failed"
            },
          })
          .returning()
        toolExecutionRecord = execution
      }

      // Mark step as failed
      await db
        .update(workflowStepExe)
        .set({
          status: "blocked",
          completedBy: null,

          // Tool execution IDs managed separately
        })
        .where(eq(workflowStepExe.id, parseInt(currentStepId, 10)))

      // Mark workflow as failed
      await db
        .update(workflowExe)
        .set({
          status: "draft",
          completedAt: new Date(),
        })
        .where(eq(workflowExe.id, parseInt(executionId, 10)))

      Logger.error(`Workflow ${executionId} marked as failed due to step ${step.name} failure`)
      
      // Return error result to stop further execution
      throw new Error(`Step "${step.name}" failed: ${JSON.stringify(toolResult.result)}`)
    }

    // Create tool execution record with error handling for unicode issues
    let toolExecutionRecord
    try {
      const [execution] = await db
        .insert(workflowToolExe)
        .values({
          toolId: tool.id,
          result: toolResult.result,
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
          .insert(workflowToolExe)
          .values({
            toolId: tool.id,
            result: {
              ...sanitizedResult,
              _note: "Result was sanitized due to unicode characters",
              _original_status: toolResult.status,
            },
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
          .insert(workflowToolExe)
          .values({
            toolId: tool.id,
            result: {
              status: "executed_with_db_error",
              message:
                "Tool executed successfully but result could not be stored due to database issues",
              error: "Database storage failed",
            },
            completedAt: new Date(),
          })
          .returning()
        toolExecutionRecord = execution
      }
    }

    // Update step as completed and add tool execution ID
    await db
      .update(workflowStepExe)
      .set({
        status: "done",
        completedBy: null,

        // Tool execution IDs managed separately
      })
      .where(eq(workflowStepExe.id, parseInt(currentStepId, 10)))

    // Store results for next step
    const updatedResults = {
      ...(previousResults || {}),
      [step.name]: {
        stepId: step.id,
        result: toolResult.result,
          executedAt: new Date(),        toolExecution: toolExecutionRecord,
      },
    }

    // Find and execute next steps using connection tables
    const nextStepTemplateIds = step.workflowStepTemplateId ? await getNextStepTemplates(step.workflowStepTemplateId) : []
    if (nextStepTemplateIds.length > 0) {
      const nextSteps = await db
        .select()
        .from(workflowStepExe)
        .where(eq(workflowStepExe.workflowExeId, parseInt(executionId, 10)))

      for (const nextStepTemplateId of nextStepTemplateIds) {
        const nextStep = nextSteps.find(
          (s) => s.workflowStepTemplateId === nextStepTemplateId,
        )

        if (nextStep && nextStep.type === StepType.AUTOMATED) {
          // Recursively execute next automated step
          await executeWorkflowChain(
            executionId,
            nextStep.id.toString(),
            tools,
            updatedResults,
          )
        }
      }
    }

    // Check if this was the last step and mark workflow as completed if so
    const allStepExecutions = await db
      .select()
      .from(workflowStepExe)
      .where(eq(workflowStepExe.workflowExeId, parseInt(executionId, 10)))

    const allStepsCompleted = allStepExecutions.every(
      (stepExec) => stepExec.status === "done",
    )

    if (allStepsCompleted) {
      // Check if workflow execution is not already completed
      const [currentExecution] = await db
        .select()
        .from(workflowExe)
        .where(eq(workflowExe.id, parseInt(executionId, 10)))

      if (currentExecution && currentExecution.status !== "completed") {
        Logger.info(
          `All steps completed for workflow execution ${executionId}, marking as completed`,
        )
        await db
          .update(workflowExe)
          .set({
            status: ToolExecutionStatus.COMPLETED,
            completedAt: new Date(),
          })
          .where(eq(workflowExe.id, parseInt(executionId, 10)))
      }
    }

    return updatedResults
  } catch (error) {
    Logger.error(error, "Failed to execute workflow chain")
    return previousResults
  }
}

// Get workflow execution status (lightweight for polling)
export const GetWorkflowExecutionStatusApi = async (c: Context) => {
  try {
    const executionId = parseInt(c.req.param("executionId"), 10)

    // Get only the status field for maximum performance
    const execution = await db
      .select({
        status: workflowExe.status,
      })
      .from(workflowExe)
      .where(eq(workflowExe.id, executionId))

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
    const executionId = parseInt(c.req.param("executionId"), 10)

    // Get execution directly by ID
    const execution = await db
      .select()
      .from(workflowExe)
      .where(eq(workflowExe.id, executionId))

    if (!execution || execution.length === 0) {
      throw new HTTPException(404, { message: "Workflow execution not found" })
    }

    // Get step executions for this workflow
    const stepExecutions = await db
      .select()
      .from(workflowStepExe)
      .where(eq(workflowStepExe.workflowExeId, executionId))

    // Get all tool executions for this workflow to build toolExecIds mapping
    // WF FIX: Add where clause on workflowExeId
    const allToolExecutions = await db
      .select()
      .from(workflowToolExe)

    // Get all step templates to include descriptions
    // WF FIX: Add where clause on workflowTemplateId
    const stepTemplates = await db
      .select()
      .from(workflowStepTemplate)

    // Enhance step executions with computed relationship fields from connection tables
    // WF FIX: This `Promise.all` contains an N+1 query problem. It calls `getNextStepTemplates` and
    // `getPreviousStepTemplates` for every step, causing multiple database queries inside the loop.
    // This should be optimized by fetching all connections for the template at once and building
    // in-memory maps for relationship lookups.
    const stepExecutionsWithRelationships = await Promise.all(
      stepExecutions.map(async (step) => {
        // Get step template for description
        const stepTemplate = stepTemplates.find(st => st.id === step.workflowStepTemplateId)

        // Find tool executions associated with this step
        // Tool executions are linked via toolId - find executions using the same tool template
        const stepToolIds = step.toolIds || []
        let associatedToolExecs = allToolExecutions.filter(te => {
          // Match tool executions that use the same tool templates as this step
          return te.toolId !== null && stepToolIds.includes(te.toolId)
        })

        // Fallback for existing executions: if no toolIds in step execution, use step template toolIds
        if (associatedToolExecs.length === 0 && stepTemplate) {
          const templateToolIds = stepTemplate.toolIds || []
          associatedToolExecs = allToolExecutions.filter(te => {
            return te.toolId !== null && templateToolIds.includes(te.toolId)
          })
        }

        // Additional fallback: match by timing if no tool ID matches (for legacy executions)
        if (associatedToolExecs.length === 0 && step.completedAt) {
          associatedToolExecs = allToolExecutions.filter(te => {
            if (!te.createdAt) return false
            const stepCompletedTime = new Date(step.completedAt!).getTime()
            const toolExecTime = new Date(te.createdAt).getTime()
            const timeDiff = Math.abs(stepCompletedTime - toolExecTime)
            // Tool execution within 5 minutes of step completion
            return timeDiff <= 5 * 60 * 1000
          })
        }

        // Get the step template relationships and map them to execution IDs
        if (step.workflowStepTemplateId) {
          // Get next step template IDs from connection table
          const nextStepTemplateIds = await getNextStepTemplates(step.workflowStepTemplateId)
          const prevStepTemplateIds = await getPreviousStepTemplates(step.workflowStepTemplateId)

          // Map template IDs to execution IDs
          const nextStepIds = nextStepTemplateIds.map(templateId => {
            const correspondingExecution = stepExecutions.find(se => se.workflowStepTemplateId === templateId)
            return correspondingExecution ? correspondingExecution.id : null
          }).filter(Boolean)

          const prevStepIds = prevStepTemplateIds.map(templateId => {
            const correspondingExecution = stepExecutions.find(se => se.workflowStepTemplateId === templateId)
            return correspondingExecution ? correspondingExecution.id : null
          }).filter(Boolean)

          const parentStepId = prevStepIds.length > 0 ? prevStepIds[0] : null

          return {
            ...step,
            description: stepTemplate?.description || step.name, // Add description from template
            toolExecIds: associatedToolExecs.map(te => te.id), // Add tool execution IDs
            parentStepId,
            nextStepIds,
            prevStepIds
          }
        }

        // Fallback if no template ID
        return {
          ...step,
          description: step.name, // Fallback description
          toolExecIds: [], // No tool executions if no template
          parentStepId: null,
          nextStepIds: [],
          prevStepIds: []
        }
      })
    )

    // Get all tool executions for this workflow with tool type
    const toolExecutions = await db
      .select({
        id: workflowToolExe.id,
        toolId: workflowToolExe.toolId,
        result: workflowToolExe.result,
        completedAt: workflowToolExe.completedAt,
        createdAt: workflowToolExe.createdAt,
        toolType: workflowTool.type, // This is the tool type (form, ai_agent, email, etc.)
      })
      .from(workflowToolExe)
      .leftJoin(workflowTool, eq(workflowToolExe.toolId, workflowTool.id))

    return c.json({
      success: true,
      data: {
        ...execution[0],
        stepExecutions: stepExecutionsWithRelationships,
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

// Not used in workflow frontend ??
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
        .from(workflowStepExe)
        .where(eq(workflowStepExe.id, parseInt(stepId, 10)))

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

      const formDefinition = (formTool[0].config as any)?.value || formTool[0].config as any
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
                currentStepExecution.workflowExeId,
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
        .from(workflowStepExe)
        .where(eq(workflowStepExe.id, parseInt(stepId, 10)))

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
      .insert(workflowToolExe)
      .values({
        toolId: formTool.id,
        result: {
          formData: formData,
          submittedAt: new Date().toISOString(),
          submittedBy: "demo",
        },
        completedAt: new Date(),
      })
      .returning()

    console.log("Tool execution created successfully")

    // Update the step execution as completed
    console.log("Updating step execution...")
    await db
      .update(workflowStepExe)
      .set({
        status: "done",
        completedBy: null,
        completedAt: new Date(),
        // Tool execution IDs managed separately
        metadata: {
          ...stepExecution.metadata,
          formSubmission: {
            formData: formData,
            submittedAt: new Date().toISOString(),
            submittedBy: "demo",
          },
        },
      })
      .where(eq(workflowStepExe.id, parseInt(stepId, 10)))

    console.log("Step execution updated successfully")

    // Continue workflow execution - execute next automated steps
    const tools = await db.select().from(workflowTool)
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

    // Execute next steps if they are automated using connection tables
    const nextStepTemplateIds = await getNextStepTemplates(stepExecution.workflowStepTemplateId)
    if (nextStepTemplateIds.length > 0) {
      const allSteps = await db
        .select()
        .from(workflowStepExe)
        .where(
          eq(
            workflowStepExe.workflowExeId,
            stepExecution.workflowExeId,
          ),
        )

      for (const nextStepTemplateId of nextStepTemplateIds) {
        const nextStep = allSteps.find(
          (s) => s.workflowStepTemplateId === nextStepTemplateId,
        )

        if (nextStep && nextStep.type === StepType.AUTOMATED) {
          await executeWorkflowChain(
            stepExecution.workflowExeId.toString(),
            nextStep.id.toString(),
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
        nextStepsTriggered: nextStepTemplateIds.length || 0,
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
const extractContentFromPath = (
  previousStepResults: any,
  contentPath: string,
): string => {
  try {
    // New simplified approach: input.* always points to latest.result.*
    // Examples: "input.aiOutput" -> latest step's result.aiOutput
    //          "input.output" -> latest step's result.output

    if (!contentPath.startsWith("input.")) {
      return `Invalid path: ${contentPath}. Only paths starting with 'input.' are supported.`
    }

    // Get the latest step
    const stepKeys = Object.keys(previousStepResults)
    if (stepKeys.length === 0) {
      return "No previous steps available"
    }

    const latestStepKey = stepKeys[stepKeys.length - 1]
    const latestStepResult = previousStepResults[latestStepKey]

    if (!latestStepResult?.result) {
      return "Latest step has no result data"
    }

    // Remove "input." prefix and navigate from latest step's result
    const propertyPath = contentPath.slice(6) // Remove "input."
    const pathParts = propertyPath.split(".")

    let target = latestStepResult.result

    // Navigate through the path starting from result
    for (const part of pathParts) {
      if (target && typeof target === "object" && part in target) {
        target = target[part]
      } else {
        return `Property '${part}' not found in latest step result`
      }
    }

    // Convert result to string
    if (typeof target === "string") {
      return target
    } else if (target !== null && target !== undefined) {
      return JSON.stringify(target, null, 2)
    }

    return "No content found"
  } catch (error) {
    console.error("Error extracting content from path:", error)
    return `Error: ${error instanceof Error ? error.message : String(error)}`
  }
}

// Execute workflow tool (Python scripts, etc.)
const executeWorkflowTool = async (
  tool: any,
  previousStepResults: any = {},
) => {
  try {
    switch (tool.type) {
      case "form":
        // Form tools are handled by form submission API
        return {
          status: "awaiting_user_input",
          result: {
            formDefinition: tool.config?.value || tool.config,
            message: "User input required - handled by form submission API",
          },
        }

      case "python_script":
        // Execute actual Python script from database using unified function
        const toolValue = tool.config?.value || tool.config
        const scriptContent =
          typeof toolValue === "string" ? toolValue : toolValue?.script
        const config = tool.config

        if (!scriptContent) {
          return {
            status: "error",
            result: { error: "No script content found in tool value" },
          }
        }

        // Use unified Python execution function
        return await executePythonScript(
          scriptContent,
          previousStepResults,
          config,
          "python_script",
        )

      case "email":
        // Enhanced email tool using config for recipients and configurable path for content extraction
        const emailConfig = tool.config || {}
        const toEmail = emailConfig.to_email || emailConfig.recipients || []
        const fromEmail = emailConfig.from_email || "no-reply@xyne.io"
        const subject = emailConfig.subject || "Workflow Results"
        const contentType = emailConfig.content_type || "html"

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
            // Fallback to extracting from response.aiOutput path
            emailBody = extractContentFromPath(previousStepResults, "input.aiOutput")
            if (!emailBody) {
              emailBody = "No content available from previous step"
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
            <h2>🤖 Workflow Results</h2>
            <p>Generated on: ${new Date().toLocaleString()}</p>
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
        // Enhanced AI agent with Text/Form input type support
        const aiConfig = tool.config || {}
        const aiValue = tool.config?.value || tool.config || {}
        
        const inputType = aiConfig.inputType || "text" // Default to text
        const aiModelEnum = aiConfig.aiModel || aiConfig.model || "vertex-gemini-2-5-flash"
        const prompt = aiValue.prompt || aiValue.systemPrompt || "Please analyze the provided content"

        // Convert enum value to actual API model name
        const aiModel = getActualNameFromEnum(aiModelEnum) || "gemini-2.5-flash"
        
        // Map to Models enum for provider selection, preferring VertexAI for compatible models
        let modelId: Models
        const isModels = (v: string): v is Models =>
          (Object.values(Models) as string[]).includes(v as Models)
        
        // Map Google AI models to their VertexAI equivalents for better enterprise integration
        switch (aiModelEnum) {
          case "googleai-gemini-2-5-flash":
            modelId = Models.Vertex_Gemini_2_5_Flash
            break
          case "googleai-gemini-2-0-flash-thinking":
            // Map to closest VertexAI equivalent or keep original if no direct mapping
            modelId = Models.Vertex_Gemini_2_5_Flash // fallback to 2.5 Flash
            break
          default:
            // Check if it's already a valid model enum, otherwise use a fallback
            if (Object.values(Models).includes(aiModelEnum as Models)) {
              modelId = aiModelEnum as Models;
            } else {
              Logger.warn(`Unsupported model enum: '${aiModelEnum}', falling back to Vertex_Gemini_2_5_Flash.`);
              modelId = Models.Vertex_Gemini_2_5_Flash;
            }
        }
        
        Logger.info(`Using model enum: ${aiModelEnum}, actual model: ${aiModel}`)
        try {
          let analysisInput = ""
          let inputMetadata = {}

          if (inputType === "form") {
            // Extract form data and files from previous step results
            const prevStepData = Object.values(previousStepResults)[0] as any
            const formSubmission =
              prevStepData?.formSubmission?.formData ||
              prevStepData?.result?.formData ||
              {}

            // Process text fields
            const textFields = Object.entries(formSubmission)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n")

            // Process uploaded files
            const fileContents = []
            for (const [, value] of Object.entries(formSubmission)) {
              if (value && typeof value === "object" && (value as any).absolutePath) {
                try {
                  const fileData = value as any
                  const fileExt = fileData.fileExtension?.toLowerCase()

                  if (fileExt === "txt") {
                    // Text files - read directly
                    const fs = await import("node:fs/promises")
                    const content = await fs.readFile(
                      fileData.absolutePath,
                      "utf-8",
                    )
                    fileContents.push(
                      `File: ${fileData.originalFileName}\nContent:\n${content}`,
                    )
                  } else if (fileExt === "pdf") {
                    // PDF files - extract text using pdf-parse (Node.js friendly)
                    try {
                      const fs = await import("node:fs/promises")
                      const pdfParse = require("pdf-parse")

                      // Read PDF file
                      const pdfBuffer = await fs.readFile(fileData.absolutePath)

                      // Parse PDF with pdf-parse
                      const pdfData = await pdfParse(pdfBuffer)

                      const cleanedText = pdfData.text.trim()
                      if (cleanedText && cleanedText.length > 10) {
                        fileContents.push(
                          `File: ${fileData.originalFileName}\nContent:\n${cleanedText}`,
                        )
                      } else {
                        fileContents.push(
                          `File: ${fileData.originalFileName}\nContent: [PDF file - no readable text found]`,
                        )
                      }
                    } catch (pdfError) {
                      // Fallback: just indicate PDF was processed but couldn't extract text
                      fileContents.push(
                        `File: ${fileData.originalFileName}\nType: PDF document (${fileData.fileSize} bytes)\nNote: PDF text extraction failed. File contains ${fileData.fileSize} bytes of content that may include text, images, or other data.`,
                      )
                    }
                  } else if (
                    ["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(
                      fileExt,
                    )
                  ) {
                    // Image files - OCR text extraction using sharp + canvas
                    try {
                      const fs = await import("node:fs/promises")
                      const sharp = await import("sharp")

                      // Convert image to high-contrast format for better OCR
                      const imageBuffer = await fs.readFile(
                        fileData.absolutePath,
                      )
                      await sharp
                        .default(imageBuffer)
                        .greyscale()
                        .normalize()
                        .sharpen()
                        .png()
                        .toBuffer()

                      // For now, indicate image was processed but OCR would need additional setup
                      // Full OCR would require tesseract.js or similar
                      const imageInfo = await sharp
                        .default(imageBuffer)
                        .metadata()
                      fileContents.push(
                        `File: ${fileData.originalFileName}\nType: Image (${imageInfo.width}x${imageInfo.height} ${fileExt.toUpperCase()})\nNote: Image processed but text extraction requires OCR setup. Image contains visual content that may include text, charts, or diagrams.`,
                      )
                    } catch (imageError) {
                      fileContents.push(
                        `File: ${fileData.originalFileName}\nError: Image processing failed - ${(imageError as Error).message}`,
                      )
                    }
                  } else if (["doc", "docx"].includes(fileExt)) {
                    // Word documents - would need additional library like mammoth
                    fileContents.push(
                      `File: ${fileData.originalFileName}\nType: Microsoft Word document\nNote: Word document processing requires additional setup. File contains ${fileData.fileSize} bytes of content.`,
                    )
                  } else {
                    // Unsupported file type
                    fileContents.push(
                      `File: ${fileData.originalFileName}\nType: ${fileExt.toUpperCase()} (${fileData.fileSize} bytes)\nNote: File type not supported for content extraction`,
                    )
                  }
                } catch (fileError) {
                  fileContents.push(
                    `File: ${(value as any).originalFileName}\nError: Could not read file - ${(fileError as Error).message}`,
                  )
                }
              }
            }

            analysisInput = [textFields, ...fileContents]
              .filter(Boolean)
              .join("\n\n")
            inputMetadata = {
              inputType: "form",
              formFields: Object.keys(formSubmission).length,
              filesProcessed: fileContents.length,
            }
          } else {
            // Text input - get from previous step result
            const prevStepData = Object.values(previousStepResults)[0] as any
            analysisInput =
              prevStepData?.result?.output ||
              prevStepData?.result?.content ||
              JSON.stringify(prevStepData?.result || {})
            inputMetadata = {
              inputType: "text",
              sourceStep: Object.keys(previousStepResults)[0] || "unknown",
            }
          }

          if (!analysisInput.trim()) {
            return {
              status: "error",
              result: {
                error: "No input content found for AI analysis",
                inputType,
                inputMetadata,
              },
            }
          }

          // Use VertexAI provider instead of direct Gemini API
          const fullPrompt = `${prompt}\n\nInput to analyze:\n${analysisInput.slice(0, 8000)}`
          Logger.info(`Calling VertexAI provider with model: ${modelId}`)
          
          const messages: Message[] = [
            {
              role: "user",
              content: [
                {
                  text: fullPrompt,
                },
              ],
            },
          ]

          const modelParams = {
            modelId,
            systemPrompt: "You are an AI assistant that analyzes content and provides helpful insights.",
            maxTokens: 2048,
            temperature: 0.3,
            stream: false,
          }

          const provider = getProviderByModel(modelId)
          const response = await provider.converse(messages, modelParams)

          if (!response.text) {
            return {
              status: "error",
              result: {
                error: "No response from AI provider",
                inputType,
                inputMetadata,
              },
            }
          }

          const aiOutput = response.text

          return {
            status: "success",
            result: {
              aiOutput,
              model: aiModel,
              modelEnum: aiModelEnum,
              inputType,
              inputMetadata,
              cost: response.cost || 0,
              processedAt: new Date().toISOString(),
            },
          }
        } catch (error) {
          return {
            status: "error",
            result: {
              error: "AI agent execution failed",
              message: error instanceof Error ? error.message : String(error),
              inputType: aiConfig.inputType,
              modelEnum: aiModelEnum,
              model: aiModel,
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

// Not used in workflow frontend ??
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

// Not used in workflow frontend ??
// Create workflow template
export const CreateWorkflowTemplateApi = async (c: Context) => {
  try {
    const requestData = await c.req.json()

    // WF FIX: This is a temporary shortcut. Ideally, the API should accept a category and subcategory,
    // query for that specific service config, and create it if it doesn't exist.
    // The current implementation just grabs the first available config.
    // Check if a default workflow service config exists, create one if needed
    let defaultServiceConfig = await db
      .select()
      .from(workflowServiceConfig)
      .limit(1)

    if (defaultServiceConfig.length === 0) {
      // Create a default service config
      const [newServiceConfig] = await db
        .insert(workflowServiceConfig)
        .values({
          name: "Default Service Config",
          category: "general",
          subcategory: "default",
          status: "active",
          metadata: { created_for: "api_template_creation" },
        })
        .returning()
      defaultServiceConfig = [newServiceConfig]
    }

    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name: requestData.name,
        description: requestData.description,
        version: requestData.version || "1.0.0",
        status: "draft",
        config: requestData.config || {},
        workflowServiceConfigId: defaultServiceConfig[0].id,
        // workspaceId: null - Leave as null for now, TODO: Get from context
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
    const requestData = await c.req.json()

    // WF FIX: This is a temporary shortcut. Ideally, the API should accept a category and subcategory,
    // query for that specific service config, and create it if it doesn't exist.
    // The current implementation just grabs the first available config.
    // Check if a default workflow service config exists, create one if needed
    let defaultServiceConfig = await db
      .select()
      .from(workflowServiceConfig)
      .limit(1)

    if (defaultServiceConfig.length === 0) {
      // Create a default service config
      const [newServiceConfig] = await db
        .insert(workflowServiceConfig)
        .values({
          name: "Default Service Config",
          category: "general",
          subcategory: "default",
          status: "active",
          metadata: { created_for: "api_template_creation" },
        })
        .returning()
      defaultServiceConfig = [newServiceConfig]
    }

    // Create the main workflow template
    const [template] = await db
      .insert(workflowTemplate)
      .values({
        name: requestData.name,
        description: requestData.description,
        version: requestData.version || "1.0.0",
        status: "draft",
        config: requestData.config || {},
        workflowServiceConfigId: defaultServiceConfig[0].id,
        // workspaceId: TODO: Get from context as integer
      })
      .returning()

    const templateId = template.id
    
    // Create workflow tools first (needed for step tool references)
    const toolIdMap = new Map<string, number>() // frontend tool ID -> backend tool ID
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
        processedConfig = {
          ...processedConfig,
          inputType: "form"
        }
      }
      
      // WF FIX: This should probably be inserting into workflowToolTemplate, but the schema seems to be in flux.
      // Sticking with workflowTool for now to match the existing pattern.
      const [createdTool] = await db
        .insert(workflowTool)
        .values({
          type: tool.type,
          config: {
            ...processedConfig,
            value: processedValue,
          },
          })
        .returning()
      
      createdTools.push(createdTool)
      
      // Map frontend tool ID to backend tool ID
      if (tool.id) {
        toolIdMap.set(tool.id, createdTool.id)
      }
    }
    
    // Create workflow step templates
    const stepIdMap = new Map<string, number>() // frontend step ID -> backend step ID
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
          toolIds: [], // Will be updated in second pass
        })
        .returning()
      
      createdSteps.push(createdStep)
      stepIdMap.set(stepData.id, createdStep.id)
    }
    
    // Second pass: create connections and update tool mappings based on edges
    for (const step of createdSteps) {
      const frontendStepId = [...stepIdMap.entries()].find(([_, backendId]) => backendId === step.id)?.[0]
      const correspondingNode = requestData.nodes.find((n: any) => n.data.step.id === frontendStepId)

      // Find edges where this step is involved
      const outgoingEdges = requestData.edges.filter((edge: any) => edge.source === frontendStepId)

      // Create connections to next steps using connection table
      for (const edge of outgoingEdges) {
        const nextStepBackendId = stepIdMap.get(edge.target)
        if (nextStepBackendId) {
          await createStepTemplateConnection(step.id, nextStepBackendId)
        }
      }

      // Map tool IDs for this step
      const stepToolIds: number[] = []
      if (correspondingNode?.data?.tools) {
        for (const tool of correspondingNode.data.tools) {
          if (tool.id && toolIdMap.has(tool.id)) {
            stepToolIds.push(toolIdMap.get(tool.id)!)
          } else {
            // Find tool by type and config if no ID mapping
            const matchingTool = createdTools.find(t =>
              t.type === tool.type &&
              JSON.stringify(t.config) === JSON.stringify({ ...tool.config, value: tool.value })
            )
            if (matchingTool) {
              stepToolIds.push(matchingTool.id)
            }
          }
        }
      }

      // Update the step with tool IDs only
      await db
        .update(workflowStepTemplate)
        .set({
          toolIds: stepToolIds,
        })
        .where(eq(workflowStepTemplate.id, step.id))
    }
    
    // Set root step (first step in the workflow - usually form submission or trigger)
    let rootStepId = null
    if (createdSteps.length > 0) {
      // Use helper function to find root step after connections are created
      rootStepId = await findRootStepTemplate(templateId)

      if (rootStepId) {
        // Update template with root step ID
        await db
          .update(workflowTemplate)
          .set({
            rootWorkflowStepTemplateId: rootStepId,
          })
          .where(eq(workflowTemplate.id, templateId))
      }
    }
    
    // Return the complete workflow template with steps and tools
    const completeTemplate = {
      ...template,
      rootWorkflowStepTemplateId: rootStepId,
      steps: createdSteps,
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

// Not used in workflow frontend ??
// Update workflow template
export const UpdateWorkflowTemplateApi = async (c: Context) => {
  try {
    const templateId = parseInt(c.req.param("templateId"), 10)
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

// Not used in workflow frontend ??
// Create workflow execution
export const CreateWorkflowExecutionApi = async (c: Context) => {
  try {
    const requestData = await c.req.json()

    const [execution] = await db
      .insert(workflowExe)
      .values({
        workflowTemplateId: requestData.workflowTemplateId,
        name: requestData.name,
        description: requestData.description,
        metadata: requestData.metadata || {},
        status: "draft",
        workspaceId: 1, // Default integer workspace ID
        rootWorkflowStepExeId: null,
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
      whereConditions.push(eq(workflowExe.id, query.id))
    }

    // Filter by name (partial match, case-insensitive)
    if (query.name) {
      whereConditions.push(ilike(workflowExe.name, `%${query.name}%`))
    }

    // Filter by date range (using createdAt as startDate)
    if (query.from_date) {
      whereConditions.push(
        gte(workflowExe.createdAt, new Date(query.from_date)),
      )
    }

    if (query.to_date) {
      whereConditions.push(
        lte(workflowExe.createdAt, new Date(query.to_date)),
      )
    }

    // Calculate offset for pagination
    const offset = (query.page - 1) * query.limit

    // Build and execute query with filters, sorting, and pagination
    const baseQuery = db.select().from(workflowExe)

    let executions
    if (whereConditions.length > 0) {
      executions = await baseQuery
        .where(and(...whereConditions))
        .orderBy(desc(workflowExe.createdAt)) // WF FIX: Changed to sort by updatedAt
        .limit(query.limit)
        .offset(offset)
    } else {
      executions = await baseQuery
        .orderBy(desc(workflowExe.createdAt)) // WF FIX: Changed to sort by updatedAt
        .limit(query.limit)
        .offset(offset)
    }

    // Get total count for pagination info
    const baseCountQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(workflowExe)

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
        config: {
          ...(requestData.config || {}),
          value: requestData.value,
        },
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

// Not used in workflow frontend ??
// Update workflow tool
export const UpdateWorkflowToolApi = async (c: Context) => {
  try {
    const toolId = parseInt(c.req.param("toolId"), 10)
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

// Not used in workflow frontend ??
// Get single workflow tool
export const GetWorkflowToolApi = async (c: Context) => {
  try {
    const toolId = parseInt(c.req.param("toolId"), 10)

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

// Not used in workflow frontend ??
// Delete workflow tool
export const DeleteWorkflowToolApi = async (c: Context) => {
  try {
    const toolId = parseInt(c.req.param("toolId"), 10)

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
    const templateId = parseInt(c.req.param("templateId"), 10)
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
        config: {
          ...requestData.tool.config,
          value: requestData.tool.value,
        },
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
        // Step relationships now managed by connection tables
        toolIds: [newTool.id],
        timeEstimate: requestData.timeEstimate || 300,
        metadata: {
          icon: getStepIcon(requestData.tool.type),
          step_order: stepOrder, // WF FIX: Lets move to a column itself?
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
      // Find the current last step (step with no outgoing connections)
      // WF FIX: This loop causes an N+1 query problem by calling `getNextStepTemplates` (which queries the db)
      // for each step. A better approach is to fetch all `fromStepId`s from the connection table for this
      // template at once, and then find the step in memory whose ID is not in the `fromStepId` set.
      let currentLastStep = null
      for (const step of existingSteps) {
        const nextSteps = await getNextStepTemplates(step.id)
        if (nextSteps.length === 0) {
          currentLastStep = step
          break
        }
      }

      if (currentLastStep) {
        // Create connection from current last step to new step
        await createStepTemplateConnection(currentLastStep.id, newStep.id)

        Logger.info(`Connected step ${currentLastStep.id} -> ${newStep.id}`)
      }
    }

    // WF FIX: This is a redundant query. The `db.update` call earlier can be chained with `.returning()`
    // to get the updated template in a single call, avoiding this extra `select`.
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
  }
  return iconMap[toolType] || "⚙️"
}

// Not used in workflow frontend ??
// Delete workflow step template API
export const DeleteWorkflowStepTemplateApi = async (c: Context) => {
  try {
    const stepId = parseInt(c.req.param("stepId"), 10)

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

    // 3. Handle step chain reconnection using connection tables
    const prevStepIds = await getPreviousStepTemplates(stepId)
    const nextStepIds = await getNextStepTemplates(stepId)

    // Create new connections from previous steps to next steps (skip the deleted step)
    for (const prevStepId of prevStepIds) {
      for (const nextStepId of nextStepIds) {
        await createStepTemplateConnection(prevStepId, nextStepId)
      }
    }

    // Delete all connections involving the step to be deleted
    await deleteStepTemplateConnections(stepId)

    // 5. Handle root step updates
    let newRootStepId = template.rootWorkflowStepTemplateId
    const isRootStep = template.rootWorkflowStepTemplateId === stepId

    if (isRootStep) {
      // If deleting root step, set the first next step as new root
      // If no next steps, set to null
      newRootStepId = nextStepIds.length > 0 ? nextStepIds[0] : null

      const updateData: any = {
        updatedAt: new Date(),
      }
      if (newRootStepId) {
        updateData.rootWorkflowStepTemplateId = newRootStepId
      } else {
        updateData.rootWorkflowStepTemplateId = null
      }

      await db
        .update(workflowTemplate)
        .set(updateData)
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
    const stepId = parseInt(c.req.param("stepId"), 10)
    const requestData = await c.req.json()

    const [stepExecution] = await db
      .update(workflowStepExe)
      .set({
        status: requestData.status,
        completedBy: requestData.completedBy,
        completedAt: requestData.status === "done" ? new Date() : null,
        metadata: requestData.metadata,
      })
      .where(eq(workflowStepExe.id, stepId))
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
    const stepId = parseInt(c.req.param("stepId"), 10)

    const [stepExecution] = await db
      .update(workflowStepExe)
      .set({
        status: "done",
        completedBy: null,
        
      })
      .where(eq(workflowStepExe.id, stepId))
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

// Not used in workflow frontend ??
// Submit form step (alias for SubmitWorkflowFormApi)
export const SubmitFormStepApi = SubmitWorkflowFormApi

// Not used in workflow frontend ??
// Get form definition
export const GetFormDefinitionApi = async (c: Context) => {
  try {
    const stepId = parseInt(c.req.param("stepId"), 10)

    const stepExecutions = await db
      .select()
      .from(workflowStepExe)
      .where(eq(workflowStepExe.id, stepId))

    if (!stepExecutions || stepExecutions.length === 0) {
      throw new HTTPException(404, { message: "Step execution not found" })
    }

    const stepExecution = stepExecutions[0]

    if (!stepExecution.workflowStepTemplateId) {
      throw new HTTPException(400, { message: "Step execution has no template ID" })
    }

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
        formDefinition: (formTool[0].config as any)?.value || formTool[0].config,
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

// Not used in workflow frontend ??
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

// Not used in workflow frontend ??
// Legacy endpoint - kept for backward compatibility but redirects to VertexAI
export const GetGeminiModelEnumsApi = async (c: Context) => {
  Logger.warn("GetGeminiModelEnumsApi is deprecated, use GetVertexAIModelEnumsApi instead")
  return GetVertexAIModelEnumsApi(c)
}

// Not used in workflow frontend ??
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
