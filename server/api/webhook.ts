import { Hono, type Context } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db } from "@/db/client"
import { 
  workflowTemplate, 
  workflowTool, 
  workflowStepTemplate,
  workflowExecution
} from "@/db/schema/workflows"
import { eq, and } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { ToolType, WorkflowStatus } from "@/types/workflowTypes"
import { HTTPException } from "hono/http-exception"
import webhookExecutionService from "@/services/webhookExecutionService"
import webhookAuthService from "@/services/webhookAuthService"
import webhookIntegrationService from "@/services/webhookIntegrationService"
import { webhookRegistry, type WebhookConfig } from "@/services/webhookRegistry"
import config from "@/config"

const Logger = getLogger(Subsystem.WorkflowApi)

// Webhook configuration schema for validation
const webhookConfigSchema = z.object({
  webhookUrl: z.string(),
  httpMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  path: z.string().min(1),
  authentication: z.enum(["none", "basic", "bearer", "api_key"]),
  selectedCredential: z.string().optional(),
  responseMode: z.enum(["immediately", "wait_for_completion", "custom"]),
  options: z.record(z.string(), z.any()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  queryParams: z.record(z.string(), z.string()).optional(),
  requestBody: z.string().optional(),
})

// Webhook request handler
export const handleWebhookRequest = async (c: Context, path: string): Promise<Response> => {
  let webhookData: any = null
  
  try {
    const method = c.req.method
    webhookData = webhookRegistry.getWebhook(path)

    if (!webhookData) {
      await webhookAuthService.auditWebhookAccess(c, path, false, "Webhook not found")
      throw new HTTPException(404, { message: `Webhook not found for path: ${path}` })
    }

    // Validate HTTP method
    if (method !== webhookData.httpMethod) {
      await webhookAuthService.auditWebhookAccess(c, path, false, `Method ${method} not allowed`)
      throw new HTTPException(405, { 
        message: `Method ${method} not allowed. Expected ${webhookData.httpMethod}` 
      })
    }

    // Validate authentication if required
    if (webhookData.config.authentication !== 'none') {
      const authValid = await webhookAuthService.validateAuthentication(c, {
        authentication: webhookData.config.authentication,
        selectedCredential: webhookData.config.selectedCredential,
        headers: webhookData.config.headers
      })
      
      if (!authValid) {
        await webhookAuthService.auditWebhookAccess(c, path, false, "Authentication failed")
        throw new HTTPException(401, { message: "Authentication failed" })
      }
    }

    // Validate custom headers if specified
    if (webhookData.config.headers && Object.keys(webhookData.config.headers).length > 0) {
      await webhookAuthService.validateCustomHeaders(c, webhookData.config.headers)
    }

    // Extract request data
    const requestData = await extractRequestData(c, webhookData.config)

    // Execute workflow
    const executionId = await executeWorkflowFromWebhook(
      webhookData.workflowTemplateId,
      requestData,
      webhookData.config
    )

    // Return response based on response mode
    const response = await buildWebhookResponse(
      webhookData.config.responseMode,
      executionId,
      requestData
    )

    // Audit successful access
    await webhookAuthService.auditWebhookAccess(c, path, true)

    return c.json(response)

  } catch (error) {
    Logger.error(`Webhook error for path ${path}: ${error}`)
    
    // Audit failed access if we have webhook data
    if (webhookData) {
      await webhookAuthService.auditWebhookAccess(c, path, false, error instanceof Error ? error.message : "Unknown error")
    }
    
    if (error instanceof HTTPException) {
      throw error
    }
    
    throw new HTTPException(500, { message: "Internal webhook error" })
  }
}


// Extract request data
async function extractRequestData(c: Context, config: WebhookConfig) {
  const contentType = c.req.header('Content-Type') || ''
  let body = null

  try {
    if (contentType.includes('application/json')) {
      body = await c.req.json()
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      body = await c.req.parseBody()
    } else if (contentType.includes('text/')) {
      body = await c.req.text()
    } else if (c.req.method !== 'GET') {
      body = await c.req.arrayBuffer()
    }
  } catch (error) {
    Logger.warn(`Failed to parse request body: ${error}`)
  }

  // Extract headers (excluding sensitive auth headers)
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    // Include most headers but exclude sensitive ones
    if (!key.toLowerCase().includes('authorization') && !key.toLowerCase().includes('cookie')) {
      headers[key] = value
    }
  })

  return {
    method: c.req.method,
    path: c.req.path,
    headers: headers,
    query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
    body,
    timestamp: new Date().toISOString(),
    url: c.req.url
  }
}

// Execute workflow from webhook trigger
async function executeWorkflowFromWebhook(
  templateId: string,
  requestData: any,
  config: WebhookConfig
): Promise<string> {
  try {
    // Get template to fetch userId and workspaceId
    const [template] = await db
      .select()
      .from(workflowTemplate)
      .where(eq(workflowTemplate.id, templateId))
      .limit(1)

    if (!template) {
      throw new Error(`Workflow template not found: ${templateId}`)
    }

    const executionId = await webhookExecutionService.executeWorkflowFromWebhook({
      workflowTemplateId: templateId,
      webhookPath: config.path,
      requestData,
      userId: template.userId,
      workspaceId: template.workspaceId
    })

    Logger.info(`Created workflow execution ${executionId} from webhook ${config.path}`)
    return executionId
    
  } catch (error) {
    Logger.error(`Failed to execute workflow from webhook: ${error}`)
    throw new Error("Failed to execute workflow")
  }
}

// Build webhook response
async function buildWebhookResponse(
  responseMode: string,
  executionId: string,
  _requestData: any
) {
  switch (responseMode) {
    case 'immediately':
      return {
        success: true,
        message: "Webhook received and workflow started",
        executionId,
        timestamp: new Date().toISOString()
      }
      
    case 'wait_for_completion':
      try {
        // Wait for execution to complete (with timeout)
        const result = await waitForExecution(executionId, 30000) // 30 second timeout
        return {
          success: true,
          message: "Webhook processed and workflow completed",
          executionId,
          status: result.status,
          result: result.execution,
          timestamp: new Date().toISOString()
        }
      } catch (error) {
        return {
          success: false,
          message: "Webhook processed but workflow did not complete in time",
          executionId,
          status: "timeout",
          timestamp: new Date().toISOString()
        }
      }
      
    default:
      return {
        success: true,
        executionId
      }
  }
}

// Wait for execution completion
async function waitForExecution(executionId: string, timeoutMs: number) {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await webhookExecutionService.getExecutionStatus(executionId)
      
      if (status.status === WorkflowStatus.COMPLETED || status.status === WorkflowStatus.FAILED) {
        return status
      }
      
      // Wait 1 second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000))
      
    } catch (error) {
      Logger.error(`Error checking execution status: ${error}`)
      break
    }
  }
  
  throw new Error("Execution timeout")
}

// API endpoints for webhook management
export const webhookRouter = new Hono()

// Register webhook (called when saving webhook tool)
webhookRouter.post('/register', zValidator('json', webhookConfigSchema), async (c) => {
  try {
    const config = c.req.valid('json') 
    const { workflowTemplateId, toolId } = c.req.query()

    await webhookRegistry.registerWebhook(config.path, workflowTemplateId, toolId, config)

    return c.json({ 
      success: true, 
      message: "Webhook registered successfully",
      webhookUrl: `${new URL(c.req.url).origin}/workflow/webhook${config.path}`
    })
  } catch (error) {
    throw new HTTPException(400, { message: `Failed to register webhook: ${error}` })
  }
})

// Unregister webhook
webhookRouter.delete('/unregister/:path', async (c) => {
  try {
    const path = `/${c.req.param('path')}`
    const success = await webhookRegistry.unregisterWebhook(path)

    if (!success) {
      throw new HTTPException(404, { message: "Webhook not found" })
    }

    return c.json({ success: true, message: "Webhook unregistered successfully" })
  } catch (error) {
    throw new HTTPException(400, { message: `Failed to unregister webhook: ${error}` })
  }
})

// List all registered webhooks
webhookRouter.get('/list', async (c) => {
  try {
    const webhooks = webhookRegistry.getAllWebhooks()
    return c.json({ success: true, webhooks })
  } catch (error) {
    throw new HTTPException(500, { message: "Failed to list webhooks" })
  }
})

// Get webhook tool configuration
webhookRouter.get('/tool/:toolId', async (c) => {
  try {
    const toolId = c.req.param('toolId')
    const config = await webhookIntegrationService.getWebhookToolConfig(toolId)
    
    if (!config) {
      throw new HTTPException(404, { message: "Webhook tool not found" })
    }
    
    return c.json({ success: true, config })
  } catch (error) {
    throw new HTTPException(500, { message: `Failed to get webhook config: ${error}` })
  }
})

// Validate webhook path
webhookRouter.post('/validate-path', zValidator('json', z.object({
  path: z.string().min(1),
  excludeToolId: z.string().optional()
})), async (c) => {
  try {
    const { path, excludeToolId } = c.req.valid('json')
    const isValid = await webhookIntegrationService.validateWebhookPath(path, excludeToolId)
    
    return c.json({ 
      success: true, 
      valid: isValid,
      message: isValid ? "Path is available" : "Path is already in use"
    })
  } catch (error) {
    throw new HTTPException(500, { message: `Failed to validate path: ${error}` })
  }
})

// Get execution status
webhookRouter.get('/execution/:executionId/status', async (c) => {
  try {
    const executionId = c.req.param('executionId')
    const status = await webhookExecutionService.getExecutionStatus(executionId)
    
    return c.json({ success: true, status })
  } catch (error) {
    throw new HTTPException(500, { message: `Failed to get execution status: ${error}` })
  }
})

// Test webhook endpoint (for debugging)
webhookRouter.post('/test/:path', async (c) => {
  try {
    const path = `/${c.req.param('path')}`
    const method = c.req.method
    
    Logger.info(`Testing webhook ${method} ${path}`)
    
    // This simulates a webhook call for testing
    return await handleWebhookRequest(c, path)
    
  } catch (error) {
    throw new HTTPException(500, { message: `Webhook test failed: ${error}` })
  }
})

// handleWebhookRequest is already exported above at line 75