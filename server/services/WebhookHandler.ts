import { type Context } from "hono"
import { db } from "@/db/client"
import { 
  workflowTool, 
  workflowStepTemplate, 
  workflowTemplate, 
  workflowExecution, 
  workflowStepExecution,
  toolExecution
} from "@/db/schema/workflows"
import { ToolType, WorkflowStatus, ToolExecutionStatus } from "@/types/workflowTypes"
import { sql, eq, and, inArray } from "drizzle-orm"
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
          userId: template[0].userId,
          workspaceId: template[0].workspaceId,
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
      
      Logger.info(`📋 Template found: ${template[0].name} (${template[0].id})`)
      
      // Get all step templates and sort by dependencies
      const allStepTemplatesRaw = await db
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.workflowTemplateId, templateId))
      const allStepTemplates = this.topologicalSortSteps(allStepTemplatesRaw)
      
      if (!allStepTemplates || allStepTemplates.length === 0) {
        throw new Error(`No steps found for template: ${templateId}`)
      }
      
      Logger.info(`📋 Found ${allStepTemplates.length} step templates in workflow:`, allStepTemplates.map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        nextStepIds: s.nextStepIds
      })))
      
      // Create step executions for ALL steps in the workflow
      const stepExecutions = []
      for (const stepTemplate of allStepTemplates) {
        // Determine if this is a webhook step
        const isWebhookStep = stepTemplate.toolIds && stepTemplate.toolIds.length > 0 && 
          await this.isWebhookTool(stepTemplate.toolIds[0])
        
        const [stepExecution] = await db
          .insert(workflowStepExecution)
          .values({
            workflowExecutionId: execution.id,
            workflowStepTemplateId: stepTemplate.id,
            name: stepTemplate.name,
            type: stepTemplate.type,
            // Mark webhook steps as completed immediately, others as active
            status: isWebhookStep ? WorkflowStatus.COMPLETED : WorkflowStatus.ACTIVE,
            parentStepId: stepTemplate.parentStepId,
            prevStepIds: stepTemplate.prevStepIds,
            nextStepIds: stepTemplate.nextStepIds,
            timeEstimate: stepTemplate.timeEstimate,
            completedAt: isWebhookStep ? new Date() : null,
            completedBy: isWebhookStep ? "webhook-trigger" : null,
            metadata: {
              createdFrom: "webhook",
              webhookPath: webhookData.path,
              webhookData: webhookData,
              stepOrder: allStepTemplates.indexOf(stepTemplate),
              triggeredByWebhook: isWebhookStep
            }
          })
          .returning()
        
        stepExecutions.push(stepExecution)
        Logger.info(`📝 Created step execution: ${stepExecution.name} (${stepExecution.id}) - Status: ${stepExecution.status}, IsWebhook: ${isWebhookStep}`)
        
        // Create tool executions for this step (with webhook completion logic)
        if (stepTemplate.toolIds && stepTemplate.toolIds.length > 0) {
          await this.createToolExecutions(stepExecution.id, stepTemplate.toolIds, webhookData)
        }
      }
      
      // Use the simpler, direct execution approach to avoid double execution
      Logger.info(`🚀 Starting direct workflow execution for ${execution.id}`)
      
      // Import and call executeWorkflowChain directly with proper webhook data
      const { executeWorkflowChain } = await import("../api/workflow")
      
      // Get all tools for this workflow
      const tools = await this.getWorkflowTools(templateId, template[0].userId, template[0].workspaceId)
      
      // Get the root step to start execution
      const rootStepId = template[0].rootWorkflowStepTemplateId
      const rootStepExecution = stepExecutions.find(se => se.workflowStepTemplateId === rootStepId)
      
      if (!rootStepExecution) {
        throw new Error(`Root step execution not found for template ${templateId}`)
      }
      
      Logger.info(`🏁 Starting workflow execution from root step: ${rootStepExecution.name}`)
      
      // Execute the workflow chain with empty previous results (webhook is first step)
      executeWorkflowChain(
        execution.id,
        rootStepExecution.id,
        tools,
        {}
      ).then(async () => {
        // After workflow chain completes, do a final completion check
        Logger.info(`🔄 Workflow chain completed for ${execution.id}, checking final completion status`)
        try {
          const workflowModule = await import("../api/workflow")
          await workflowModule.checkAndCompleteWorkflow(execution.id)
        } catch (error) {
          Logger.error(`❌ Failed final completion check: ${error}`)
        }
      }).catch(error => {
        Logger.error(`❌ Async workflow execution failed: ${error}`)
      })
      
      // Add a delayed completion check as backup (after 10 seconds)
      setTimeout(async () => {
        try {
          Logger.info(`🔄 Running delayed completion check for workflow ${execution.id}`)
          const workflowModule = await import("../api/workflow")
          await workflowModule.checkAndCompleteWorkflow(execution.id)
        } catch (error) {
          Logger.error(`❌ Delayed completion check failed: ${error}`)
        }
      }, 10000)
      
      return execution.id
      
    } catch (error) {
      Logger.error(`Failed to execute workflow from webhook: ${error}`)
      throw error
    }
  }


  // Dynamic webhook handler
  async handleWebhookRequest(c: Context): Promise<Response> {
    const path = c.req.path.replace("/workflow/webhook", "")
    
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

  // Helper method to check if a tool is a webhook tool
  private async isWebhookTool(toolId: string): Promise<boolean> {
    try {
      const [tool] = await db
        .select()
        .from(workflowTool)
        .where(eq(workflowTool.id, toolId))
        .limit(1)
      
      return tool?.type === 'webhook'
    } catch (error) {
      Logger.error(`Failed to check tool type for ${toolId}: ${error}`)
      return false
    }
  }

  // Helper method to create tool executions for webhook steps
  private async createToolExecutions(stepExecutionId: string, toolIds: string[], webhookData: Record<string, unknown>) {
    for (const toolId of toolIds) {
      try {
        // Get tool details
        const [tool] = await db
          .select()
          .from(workflowTool)
          .where(eq(workflowTool.id, toolId))
          .limit(1)

        if (tool) {
          const isWebhookTool = tool.type === 'webhook'
          
          const result = isWebhookTool ? {
            webhook: {
              method: webhookData.method || 'POST',
              path: webhookData.path || "/workflow/webhook",
              url: webhookData.url || `http://localhost:3000${webhookData.path || "/workflow/webhook"}`,
              headers: webhookData.headers as Record<string, any> || {},
              query: webhookData.query as Record<string, any> || {},
              body: webhookData.body || {},
              timestamp: webhookData.timestamp || new Date().toISOString(),
              curl: this.generateCurlCommand({
                method: (webhookData.method as string) || 'POST',
                url: (webhookData.url as string) || `http://localhost:3000${webhookData.path || "/workflow/webhook"}`,
                headers: (webhookData.headers as Record<string, any>) || {},
                body: webhookData.body || {}
              })
            },
            // Create formatted content for next steps
            aiOutput: this.formatWebhookContent(webhookData),
            content: this.formatWebhookContent(webhookData),
            output: this.formatWebhookContent(webhookData),
            input: {
              aiOutput: this.formatWebhookContent(webhookData),
              content: this.formatWebhookContent(webhookData),
              summary: `Webhook received: ${webhookData.method || 'POST'} request to ${webhookData.path || "/workflow/webhook"}`,
              data: webhookData
            },
            data: webhookData,
            status: 'success',
            message: 'Webhook received and processed successfully',
            triggeredAt: new Date().toISOString()
          } : {
            webhookData: webhookData,
            queuedAt: new Date().toISOString()
          }
          
          await db
            .insert(toolExecution)
            .values({
              workflowToolId: toolId,
              workflowExecutionId: stepExecutionId,
              // Mark webhook tools as completed immediately
              status: isWebhookTool ? ToolExecutionStatus.COMPLETED : ToolExecutionStatus.PENDING,
              startedAt: new Date(),
              completedAt: isWebhookTool ? new Date() : null,
              result: result
            })
            
          Logger.info(`📝 Created tool execution for ${tool.type} tool (${toolId}) - Status: ${isWebhookTool ? 'COMPLETED' : 'PENDING'}`)
        }
      } catch (error) {
        Logger.error(`Failed to create tool execution for tool ${toolId}: ${error}`)
      }
    }
  }

  // Helper method to get workflow tools
  private async getWorkflowTools(templateId: string, userId: number, workspaceId: number) {
    try {
      Logger.info(`🔧 getWorkflowTools for template: ${templateId}`)
      
      // Get all steps for the template and sort by dependencies
      const stepsRaw = await db
        .select()
        .from(workflowStepTemplate)
        .where(eq(workflowStepTemplate.workflowTemplateId, templateId))
      const steps = this.topologicalSortSteps(stepsRaw)

      Logger.info(`📋 Found ${steps.length} step templates:`, steps.map(s => ({
        id: s.id,
        name: s.name,
        toolIds: s.toolIds
      })))

      // Get all tool IDs from steps
      const allToolIds: string[] = []
      steps.forEach(step => {
        if (step.toolIds && Array.isArray(step.toolIds)) {
          allToolIds.push(...step.toolIds)
        }
      })

      Logger.info(`🔨 Collected tool IDs:`, allToolIds)
      Logger.info(`🔧 Searching for tools with workspace ${workspaceId} and user ${userId}`)

      // Get all tools referenced by steps - fetch from same workspace/user as template
      if (allToolIds.length === 0) {
        Logger.warn(`No tool IDs found for template ${templateId}`)
        return []
      }

      const tools = await db
        .select()
        .from(workflowTool)
        .where(
          and(
            inArray(workflowTool.id, allToolIds),
            eq(workflowTool.workspaceId, workspaceId),
            eq(workflowTool.userId, userId)
          )
        )

      Logger.info(`🔨 Retrieved ${tools.length} tools for template ${templateId}:`, tools.map(t => ({
        id: t.id,
        type: t.type,
        workspaceId: t.workspaceId,
        userId: t.userId
      })))

      // If no tools found with workspace/user restriction, try without restriction for webhook execution
      if (tools.length === 0) {
        Logger.warn(`⚠️ No tools found for tool IDs: ${allToolIds.join(', ')} in workspace ${workspaceId} for user ${userId}`)
        Logger.info(`🔄 Trying to fetch tools without workspace/user restriction for webhook execution...`)
        
        // For webhook execution, allow tools from any workspace/user as fallback
        const allMatchingTools = await db
          .select()
          .from(workflowTool)
          .where(inArray(workflowTool.id, allToolIds))
        
        Logger.info(`🔍 Found ${allMatchingTools.length} matching tools without restriction:`, allMatchingTools.map(t => ({
          id: t.id,
          type: t.type,
          workspaceId: t.workspaceId,
          userId: t.userId
        })))
        
        if (allMatchingTools.length > 0) {
          Logger.info(`✅ Using tools without workspace/user restriction for webhook execution`)
          return allMatchingTools
        }
      }

      return tools

    } catch (error) {
      Logger.error(`Failed to get workflow tools for template ${templateId}: ${error}`)
      return []
    }
  }

  // Helper method to format webhook content for AI analysis
  private formatWebhookContent(requestData: any): string {
    return `Webhook Request Analysis:

Method: ${requestData.method || 'POST'}
URL: ${requestData.url || `http://localhost:3000${requestData.path || "/workflow/webhook"}`}
Path: ${requestData.path || "/workflow/webhook"}
Timestamp: ${requestData.timestamp || new Date().toISOString()}

Headers:
${JSON.stringify(requestData.headers || {}, null, 2)}

Query Parameters:
${JSON.stringify(requestData.query || {}, null, 2)}

Request Body:
${JSON.stringify(requestData.body || {}, null, 2)}

cURL Command:
${this.generateCurlCommand({
  method: (requestData.method as string) || 'POST',
  url: (requestData.url as string) || `http://localhost:3000${requestData.path || "/workflow/webhook"}`,
  headers: (requestData.headers as Record<string, any>) || {},
  body: requestData.body || {}
})}

Please analyze this webhook request and provide insights.`
  }

  // Helper method to generate cURL command from webhook data
  private generateCurlCommand(webhookData: {
    method: string
    url: string
    headers: Record<string, any>
    body: any
  }): string {
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

  // Utility function to sort steps based on their dependencies (prevStepIds/nextStepIds)
  private topologicalSortSteps(steps: any[]): any[] {
    // Create a map for quick lookup
    const stepMap = new Map(steps.map(step => [step.id, step]))
    const sorted: any[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    
    const visit = (stepId: string) => {
      if (visited.has(stepId)) return
      if (visiting.has(stepId)) {
        // Circular dependency detected, skip for now
        return
      }
      
      visiting.add(stepId)
      const step = stepMap.get(stepId)
      if (step) {
        // Visit all prerequisites first (prevStepIds)
        if (step.prevStepIds && Array.isArray(step.prevStepIds)) {
          for (const prevId of step.prevStepIds) {
            if (stepMap.has(prevId)) {
              visit(prevId)
            }
          }
        }
        
        visiting.delete(stepId)
        visited.add(stepId)
        sorted.push(step)
      }
    }
    
    // Find root steps (steps with no prevStepIds or empty prevStepIds)
    const rootSteps = steps.filter(step => 
      !step.prevStepIds || step.prevStepIds.length === 0
    )
    
    // Start with root steps
    for (const rootStep of rootSteps) {
      visit(rootStep.id)
    }
    
    // Visit any remaining unvisited steps (in case of isolated components)
    for (const step of steps) {
      if (!visited.has(step.id)) {
        visit(step.id)
      }
    }
    
    return sorted
  }

  // Initialize webhook handler by loading webhooks from database
  async initialize(): Promise<void> {
    await this.loadWebhooksFromDatabase()
  }
}

// Export singleton instance
export default WebhookHandler.getInstance()