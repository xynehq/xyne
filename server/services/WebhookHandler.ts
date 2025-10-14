import { type Context } from "hono"
import { db } from "@/db/client"
import { 
  workflowTool, 
  workflowStepTemplate, 
  workflowTemplate, 
  workflowExecution, 
  workflowStepExecution 
} from "@/db/schema/workflows"
import { ToolType, WorkflowStatus } from "@/types/workflowTypes"
import { sql, eq } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.WorkflowApi)

// Dynamic webhook registry - loads from database
interface WebhookRegistryEntry {
  workflowTemplateId: string
  toolId: string
  config: Record<string, unknown>
  value: Record<string, unknown>
}

const webhookRegistry = new Map<string, WebhookRegistryEntry>()

export class WebhookHandler {
  private static instance: WebhookHandler

  static getInstance(): WebhookHandler {
    if (!WebhookHandler.instance) {
      WebhookHandler.instance = new WebhookHandler()
    }
    return WebhookHandler.instance
  }

  // Load webhooks from database
  async loadWebhooksFromDatabase() {
    try {
      const webhookTools = await db
        .select({
          id: workflowTool.id,
          config: workflowTool.config,
          value: workflowTool.value,
          templateId: workflowStepTemplate.workflowTemplateId
        })
        .from(workflowTool)
        .innerJoin(workflowStepTemplate, sql`${workflowTool.id} = ANY(${workflowStepTemplate.toolIds})`)
        .where(eq(workflowTool.type, ToolType.WEBHOOK))

      webhookRegistry.clear()
      
      for (const tool of webhookTools) {
        try {
          const config = tool.config as Record<string, unknown>
          const value = tool.value as Record<string, unknown>
          
          // Get path from either config or value
          const webhookPath = config?.path || value?.path
          
          if (webhookPath && typeof webhookPath === 'string') {
            // Validate webhook path format
            if (!this.isValidWebhookPath(webhookPath)) {
              Logger.warn(`Invalid webhook path format: ${webhookPath}`)
              continue
            }
            
            const cleanPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`
            
            webhookRegistry.set(cleanPath, {
              workflowTemplateId: tool.templateId,
              toolId: tool.id,
              config: config || {},
              value: value || {}
            })
            
            Logger.info(`📝 Loaded webhook: ${cleanPath} -> Template: ${tool.templateId}, Tool: ${tool.id}`)
          }
        } catch (error) {
          Logger.error(`Failed to load webhook tool ${tool.id}: ${error}`)
        }
      }
      
      Logger.info(`✅ Loaded ${webhookRegistry.size} webhooks from database`)
    } catch (error) {
      Logger.error(`Failed to load webhooks from database: ${error}`)
    }
  }

  // Execute workflow from webhook trigger
  async executeWorkflowFromWebhook(
    templateId: string,
    webhookData: Record<string, unknown>,
    webhookConfig: Record<string, unknown>
  ): Promise<string> {
    // Validate required parameters
    if (!templateId || typeof templateId !== 'string') {
      throw new Error('Invalid templateId provided')
    }
    if (!webhookData || typeof webhookData !== 'object') {
      throw new Error('Invalid webhookData provided')
    }
    try {
      Logger.info(`🚀 Starting workflow execution for template: ${templateId}`)
      
      // Get the workflow template
      const template = await db
        .select()
        .from(workflowTemplate)
        .where(eq(workflowTemplate.id, templateId))
        .limit(1)
      
      if (!template || template.length === 0) {
        throw new Error(`Workflow template not found: ${templateId}`)
      }
      
      // Create workflow execution with webhook data as input
      const [execution] = await db
        .insert(workflowExecution)
        .values({
          workflowTemplateId: templateId,
          createdBy: "webhook",
          name: `Webhook execution - ${template[0].name} - ${new Date().toLocaleDateString()}`,
          description: `Webhook-triggered execution of ${template[0].name}`,
          metadata: {
            webhook: {
              path: webhookData.path,
              method: webhookData.method,
              timestamp: webhookData.timestamp,
              config: webhookConfig
            },
            webhookData: webhookData
          },
          status: WorkflowStatus.ACTIVE,
        })
        .returning()
      
      Logger.info(`📋 Created workflow execution: ${execution.id}`)
      
      // Get the root step template
      const rootStepId = template[0].rootWorkflowStepTemplateId
      if (!rootStepId) {
        throw new Error(`No root step found for template: ${templateId}`)
      }
      
      // Create step execution for the root step
      const [stepExecution] = await db
        .insert(workflowStepExecution)
        .values({
          workflowExecutionId: execution.id,
          workflowStepTemplateId: rootStepId,
          name: `Webhook step - ${webhookData.path}`,
          status: WorkflowStatus.ACTIVE,
          metadata: {
            createdFrom: "webhook",
            webhookPath: webhookData.path,
            webhookData: webhookData
          }
        })
        .returning()
      
      Logger.info(`📝 Created step execution: ${stepExecution.id}`)
      
      // Start execution asynchronously (don't wait for completion in webhook response)
      this.startWorkflowExecution(execution.id, stepExecution.id, webhookData)
        .catch(error => {
          Logger.error(`❌ Async workflow execution failed: ${error}`)
        })
      
      return execution.id
      
    } catch (error) {
      Logger.error(`Failed to execute workflow from webhook: ${error}`)
      throw error
    }
  }

  // Start workflow execution asynchronously
  async startWorkflowExecution(
    executionId: string,
    rootStepId: string,
    webhookData: Record<string, unknown>
  ) {
    try {
      Logger.info(`🔄 Starting async execution for: ${executionId}`)
      
      // Get all tools for the workflow
      const tools = await db.select().from(workflowTool)
      
      // Execute the workflow chain starting from root step
      await this.executeWorkflowChain(
        executionId,
        rootStepId,
        tools,
        webhookData
      )
      
      // Update execution status to completed
      await db
        .update(workflowExecution)
        .set({
          status: WorkflowStatus.COMPLETED,
          completedAt: new Date()
        })
        .where(eq(workflowExecution.id, executionId))
      
      Logger.info(`✅ Completed workflow execution: ${executionId}`)
      
    } catch (error) {
      Logger.error(`❌ Workflow execution failed: ${error}`)
      
      // Update execution status to failed
      await db
        .update(workflowExecution)
        .set({
          status: WorkflowStatus.FAILED,
          completedAt: new Date()
        })
        .where(eq(workflowExecution.id, executionId))
    }
  }

  // Import the execution chain function from workflow API (simplified version for webhooks)
  async executeWorkflowChain(
    _executionId: string,
    currentStepId: string,
    _tools: Record<string, unknown>[],
    previousResults: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      Logger.info(`🔗 Executing workflow chain step: ${currentStepId}`)
      
      // Update step status to running
      await db
        .update(workflowStepExecution)
        .set({
          status: WorkflowStatus.ACTIVE,
          updatedAt: new Date()
        })
        .where(eq(workflowStepExecution.id, currentStepId))
      
      // Get current step execution
      const stepExecution = await db
        .select()
        .from(workflowStepExecution)
        .where(eq(workflowStepExecution.id, currentStepId))
      
      if (!stepExecution || stepExecution.length === 0) {
        throw new Error(`Step execution not found: ${currentStepId}`)
      }
      
      const step = stepExecution[0]
      
      // For webhook triggers, we'll execute the step with the webhook data
      const result = {
        stepId: currentStepId,
        status: 'completed',
        output: previousResults,
        timestamp: new Date().toISOString()
      }
      
      // Update step status to completed
      await db
        .update(workflowStepExecution)
        .set({
          status: WorkflowStatus.COMPLETED,
          metadata: {
            ...(step.metadata || {}),
            result: result
          },
          completedAt: new Date()
        })
        .where(eq(workflowStepExecution.id, currentStepId))
      
      Logger.info(`✅ Completed workflow step: ${currentStepId}`)
      
      return result
      
    } catch (error) {
      Logger.error(`❌ Workflow step failed: ${error}`)
      
      // Update step status to failed
      await db
        .update(workflowStepExecution)
        .set({
          status: WorkflowStatus.FAILED,
          metadata: {
            error: error instanceof Error ? error.message : String(error),
            failedAt: new Date().toISOString()
          },
          completedAt: new Date()
        })
        .where(eq(workflowStepExecution.id, currentStepId))
      
      throw error
    }
  }

  // Dynamic webhook handler
  async handleWebhookRequest(c: Context): Promise<Response> {
    const path = c.req.path.replace("/webhook", "")
    
    // Sanitize and validate webhook path
    if (!path || path.length === 0) {
      Logger.warn('Empty webhook path provided')
      return c.json({ error: 'Invalid webhook path' }, 400)
    }
    
    // Prevent path traversal attacks
    if (path.includes('..') || path.includes('//')) {
      Logger.warn(`Potential path traversal attempt detected: ${path}`)
      return c.json({ error: 'Invalid webhook path format' }, 400)
    }
    
    // Get webhook from registry
    const webhook = webhookRegistry.get(path)
    
    if (!webhook) {
      Logger.warn(`Webhook not found: ${path}`)
      return c.json({ error: `Webhook not found for path: ${path}` }, 404)
    }
    
    // Validate HTTP method if specified
    const expectedMethod = webhook.config?.httpMethod || webhook.value?.httpMethod || 'POST'
    if (c.req.method !== expectedMethod) {
      Logger.warn(`Method ${c.req.method} not allowed for ${path}, expected ${expectedMethod}`)
      return c.json({ 
        error: `Method ${c.req.method} not allowed. Expected ${expectedMethod}` 
      }, 405)
    }
    
    // Validate authentication if required
    const authType = webhook.config?.authentication || 'none'
    if (authType !== 'none') {
      const authValid = await this.validateWebhookAuth(c, webhook)
      if (!authValid) {
        Logger.warn(`Authentication failed for webhook ${path}`)
        return c.json({ error: "Authentication failed" }, 401)
      }
    }
    
    Logger.info(`📥 Webhook triggered: ${path} (Template: ${webhook.workflowTemplateId})`)
    
    // Validate request body for POST method
    if (expectedMethod === 'POST') {
      const expectedRequestBody = webhook.config?.requestBody || webhook.value?.requestBody
      if (expectedRequestBody && typeof expectedRequestBody === 'string') {
        try {
          // Safely parse JSON with additional validation
          const expectedBodyObj = JSON.parse(expectedRequestBody)
          
          // Ensure the parsed result is an object
          if (!expectedBodyObj || typeof expectedBodyObj !== 'object') {
            Logger.warn(`Invalid JSON structure in configured request body for webhook ${path}`)
            return c.json({ 
              error: "Configured request body must be a valid JSON object" 
            }, 500)
          }
          
          // Try to parse the incoming request body
          let incomingBody = null
          try {
            const contentType = c.req.header('Content-Type') || ''
            if (contentType.includes('application/json')) {
              incomingBody = await c.req.json()
            } else {
              Logger.warn(`Expected JSON content type for POST webhook ${path}, got: ${contentType}`)
              return c.json({ 
                error: "Content-Type must be application/json for POST webhooks with request body validation" 
              }, 400)
            }
          } catch (parseError) {
            Logger.warn(`Failed to parse JSON body for webhook ${path}: ${parseError}`)
            return c.json({ 
              error: "Invalid JSON in request body" 
            }, 400)
          }
          
          // Basic validation - check if incoming body structure matches expected structure
          if (!incomingBody || typeof incomingBody !== 'object') {
            Logger.warn(`Invalid request body structure for webhook ${path}`)
            return c.json({ 
              error: "Request body must be a valid JSON object matching the configured structure" 
            }, 400)
          }
          
          // Validate that all required keys from expected body are present
          const expectedKeys = Object.keys(expectedBodyObj)
          const incomingKeys = Object.keys(incomingBody)
          const missingKeys = expectedKeys.filter(key => !incomingKeys.includes(key))
          
          if (missingKeys.length > 0) {
            Logger.warn(`Missing required fields in request body for webhook ${path}: ${missingKeys.join(', ')}`)
            return c.json({ 
              error: `Missing required fields: ${missingKeys.join(', ')}`,
              expectedStructure: expectedBodyObj
            }, 400)
          }
          
          Logger.info(`✅ Request body validation passed for webhook ${path}`)
          
          // Reset the request to parse again later in the flow
          // Note: We'll need to store the parsed body to avoid double parsing
          // For now, we'll let the extraction flow handle it again
          
        } catch (jsonError) {
          Logger.error(`Invalid JSON in configured request body for webhook ${path}: ${jsonError}`)
          return c.json({ 
            error: "Invalid JSON configuration in webhook request body template" 
          }, 500)
        }
      } else if (expectedRequestBody && typeof expectedRequestBody !== 'string') {
        Logger.warn(`Invalid request body type for webhook ${path}: expected string, got ${typeof expectedRequestBody}`)
        return c.json({ 
          error: "Invalid webhook configuration" 
        }, 500)
      } else {
        Logger.warn(`POST webhook ${path} missing required request body configuration`)
        return c.json({ 
          error: "Request body is mandatory for POST method webhooks" 
        }, 400)
      }
    }
    
    // Validate headers if specified
    const expectedHeaders = webhook.config?.headers || {}
    if (Object.keys(expectedHeaders).length > 0) {
      const requestHeaders = c.req.header()
      const missingHeaders = []
      
      for (const [headerName, expectedValue] of Object.entries(expectedHeaders)) {
        const actualValue = requestHeaders[headerName.toLowerCase()] || requestHeaders[headerName]
        
        if (!actualValue) {
          missingHeaders.push(headerName)
        } else if (expectedValue && actualValue !== expectedValue) {
          Logger.warn(`Header ${headerName} value mismatch for webhook ${path}: expected '${expectedValue}', got '${actualValue}'`)
          return c.json({ 
            error: `Header ${headerName} value does not match expected value` 
          }, 400)
        }
      }
      
      if (missingHeaders.length > 0) {
        Logger.warn(`Missing required headers for webhook ${path}: ${missingHeaders.join(', ')}`)
        return c.json({ 
          error: `Missing required headers: ${missingHeaders.join(', ')}` 
        }, 400)
      }
      
      Logger.info(`✅ Header validation passed for webhook ${path}`)
    }
    
    // Extract request data with size limits
    let body = null
    try {
      if (c.req.method !== 'GET') {
        const contentType = c.req.header('Content-Type') || ''
        const contentLength = c.req.header('Content-Length')
        
        // Check content length limits (10MB max)
        if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
          Logger.warn(`Request body too large for webhook ${path}: ${contentLength} bytes`)
          return c.json({ error: 'Request body too large' }, 413)
        }
        
        if (contentType.includes('application/json')) {
          body = await c.req.json()
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
          body = await c.req.parseBody()
        } else {
          body = await c.req.text()
        }
      }
    } catch (e) {
      Logger.warn(`Failed to parse request body for ${path}: ${e}`)
      return c.json({ error: 'Invalid request body format' }, 400)
    }
    
    const requestData = {
      method: c.req.method,
      path: c.req.path,
      headers: {}, // Simplified for now - can be enhanced later
      query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
      body,
      timestamp: new Date().toISOString(),
      webhookConfig: {
        toolId: webhook.toolId,
        workflowTemplateId: webhook.workflowTemplateId,
        authentication: authType
      }
    }
    
    Logger.info(`📊 Webhook data for ${path}:`, JSON.stringify(requestData, null, 2))
    
    // Start actual workflow execution here
    let executionId: string
    try {
      executionId = await this.executeWorkflowFromWebhook(
        webhook.workflowTemplateId,
        requestData,
        webhook.config
      )
      Logger.info(`✅ Workflow execution started: ${executionId} for template: ${webhook.workflowTemplateId}`)
    } catch (executionError) {
      Logger.error(`❌ Failed to execute workflow: ${executionError}`)
      return c.json({
        success: false,
        message: "Webhook received but workflow execution failed",
        // Don't expose internal error details in production
        error: process.env.NODE_ENV === 'development' 
          ? (executionError instanceof Error ? executionError.message : String(executionError))
          : 'Internal server error',
        timestamp: new Date().toISOString()
      }, 500)
    }
    
    // Return response based on configured response mode
    const responseMode = webhook.config?.responseMode || 'immediately'
    
    return c.json({
      success: true,
      message: "Webhook received and workflow started",
      executionId,
      workflowTemplateId: webhook.workflowTemplateId,
      toolId: webhook.toolId,
      responseMode,
      timestamp: new Date().toISOString(),
      data: requestData
    })
  }

  // Webhook authentication validation with stored credentials
  async validateWebhookAuth(c: Context, webhook: WebhookRegistryEntry): Promise<boolean> {
    if (!webhook || !webhook.config) {
      Logger.warn('Invalid webhook configuration for authentication')
      return false
    }
    const authType = webhook.config?.authentication || 'none'
    const authHeader = c.req.header('Authorization')
    
    switch (authType) {
      case 'basic':
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          Logger.warn('Basic authentication required but no Authorization header provided')
          return false
        }
        
        // Extract the base64 encoded credentials from Authorization header
        const providedCredentials = authHeader.replace('Basic ', '')
        
        // Find the selected credential from credentials array
        const basicCredentials = Array.isArray(webhook.config?.credentials) ? webhook.config.credentials : []
        const basicSelectedCredential = basicCredentials.find((cred: unknown) => 
          typeof cred === 'object' && cred !== null && 
          'isSelected' in cred && (cred as Record<string, unknown>).isSelected === true
        ) as Record<string, unknown> | undefined
        
        if (!basicSelectedCredential) {
          Logger.warn('No selected credential found in webhook configuration')
          return false
        }
        
        const storedCredentials = basicSelectedCredential.basic_auth as string
        
        if (!storedCredentials || typeof storedCredentials !== 'string') {
          Logger.warn('No basic_auth value found in selected credential')
          return false
        }
        
        // Use constant-time comparison to prevent timing attacks
        if (this.constantTimeEquals(providedCredentials, storedCredentials)) {
          Logger.info('Basic authentication successful')
          return true
        } else {
          Logger.warn('Basic authentication failed: credentials do not match')
          return false
        }
        
      case 'bearer':
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          Logger.warn('Bearer authentication required but no Authorization header provided')
          return false
        }
        
        // Extract the token from Authorization header
        const providedToken = authHeader.replace('Bearer ', '')
        
        // Find the selected credential from credentials array
        const bearerCredentials = Array.isArray(webhook.config?.credentials) ? webhook.config.credentials : []
        const bearerSelectedCredential = bearerCredentials.find((cred: unknown) => 
          typeof cred === 'object' && cred !== null && 
          'isSelected' in cred && (cred as Record<string, unknown>).isSelected === true
        ) as Record<string, unknown> | undefined
        
        if (!bearerSelectedCredential) {
          Logger.warn('No selected credential found in webhook configuration')
          return false
        }
        
        const storedToken = bearerSelectedCredential.bearer_token as string
        
        if (!storedToken || typeof storedToken !== 'string') {
          Logger.warn('No bearer_token value found in selected credential')
          return false
        }
        
        // Use constant-time comparison to prevent timing attacks
        if (this.constantTimeEquals(providedToken, storedToken)) {
          Logger.info('Bearer authentication successful')
          return true
        } else {
          Logger.warn('Bearer authentication failed: token does not match')
          return false
        }
        
      case 'api_key':
        const apiKey = c.req.header('X-API-Key') || c.req.query('api_key')
        if (!apiKey) {
          Logger.warn('API key authentication required but no X-API-Key header or api_key query parameter provided')
          return false
        }
        
        // Find the selected credential from credentials array
        const apiKeyCredentials = Array.isArray(webhook.config?.credentials) ? webhook.config.credentials : []
        const apiKeySelectedCredential = apiKeyCredentials.find((cred: unknown) => 
          typeof cred === 'object' && cred !== null && 
          'isSelected' in cred && (cred as Record<string, unknown>).isSelected === true
        ) as Record<string, unknown> | undefined
        
        if (!apiKeySelectedCredential) {
          Logger.warn('No selected credential found in webhook configuration')
          return false
        }
        
        const storedApiKey = apiKeySelectedCredential.api_key as string
        
        if (!storedApiKey || typeof storedApiKey !== 'string') {
          Logger.warn('No api_key value found in selected credential')
          return false
        }
        
        // Use constant-time comparison to prevent timing attacks
        if (this.constantTimeEquals(apiKey, storedApiKey)) {
          Logger.info('API key authentication successful')
          return true
        } else {
          Logger.warn('API key authentication failed: key does not match')
          return false
        }
        
      default:
        return true
    }
  }

  // Validate webhook path format
  private isValidWebhookPath(path: string): boolean {
    // Check for valid characters (alphanumeric, dash, underscore, slash)
    const validPathRegex = /^[a-zA-Z0-9\-_\/]+$/
    
    // Must not be empty and should match valid characters
    if (!path || !validPathRegex.test(path)) {
      return false
    }
    
    // Prevent path traversal
    if (path.includes('..') || path.includes('//')) {
      return false
    }
    
    // Must not exceed reasonable length (100 chars)
    if (path.length > 100) {
      return false
    }
    
    return true
  }

  // Constant-time string comparison to prevent timing attacks
  private constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false
    }
    
    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    
    return result === 0
  }

  // API endpoint to reload webhooks
  async reloadWebhooks(): Promise<{ success: boolean; message: string; count: number }> {
    try {
      await this.loadWebhooksFromDatabase()
      return { 
        success: true, 
        message: "Webhooks reloaded successfully",
        count: webhookRegistry.size 
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  }

  // API endpoint to list registered webhooks
  listWebhooks(): { success: boolean; webhooks: any[]; count: number } {
    try {
      const webhooks = Array.from(webhookRegistry.entries()).map(([path, data]) => ({
        path,
        workflowTemplateId: data.workflowTemplateId,
        toolId: data.toolId,
        httpMethod: data.config?.httpMethod || 'POST',
        authentication: data.config?.authentication || 'none',
        responseMode: data.config?.responseMode || 'immediately'
      }))
      
      return { 
        success: true, 
        webhooks,
        count: webhooks.length 
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  }

  // Get webhook registry size for debugging
  getWebhookRegistrySize(): number {
    return webhookRegistry.size
  }

  // Initialize webhook handler by loading webhooks from database
  async initialize(): Promise<void> {
    await this.loadWebhooksFromDatabase()
  }
}

// Export singleton instance
export default WebhookHandler.getInstance()