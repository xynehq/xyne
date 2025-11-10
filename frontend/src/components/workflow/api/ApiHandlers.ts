import { Flow, TemplateFlow } from "../Types"
import { api } from "../../../api"
import { UserMetadata, UserWorkflowRole } from "@/server/shared/types"

// Credential types
export interface Credential {
  id: string
  name: string
  type: "basic" | "bearer" | "api_key"
  user?: string
  password?: string
  token?: string
  apiKey?: string
  allowedDomains?: string
  isValid?: boolean
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

// API request/response types for workflow templates

interface WorkflowTemplateResponse {
  data: WorkflowTemplate[]
}
interface WorkflowTemplate {
  id: string
  name: string
  description: string
  version: string
  status: string
  config: {
    ai_model?: string
    max_file_size?: string
    auto_execution?: boolean
    schema_version?: string
    allowed_file_types?: string[]
    supports_file_upload?: boolean
  }
  userId: number
  workspaceId: number
  isPublic: boolean
  rootWorkflowStepTemplateId: string
  createdAt: string
  updatedAt: string
  role?: UserWorkflowRole
  SharedUserMetadata?: UserMetadata
  rootStep?: {
    id: string
    workflowTemplateId: string
    name: string
    description: string
    type: string
    timeEstimate: number
    metadata: {
      icon?: string
      step_order?: number
      schema_version?: string
      user_instructions?: string
    }
    tool?: {
      id: string
      type: string
      value: any
      config: any
      createdAt: string
      updatedAt: string
    }
  }
}

interface ApiTemplate {
  id: string
  workspaceId: number
  userId: number
  name: string
  description: string
  version: string
  status: string
  config: {
    steps?: Array<{
      id: number
      name: string
      type: string
    }>
    features?: string[]
    description?: string
    steps_count?: number
    ai_model?: string
    max_file_size?: string
    allowed_file_types?: string[]
    supports_file_upload?: boolean
    auto_execution?: boolean
  }
  rootWorkflowStepTemplateId: string | null
  createdAt: string
  updatedAt: string
}

interface ApiWorkflowExecution {
  id: string
  workflowTemplateId: string
  workspaceId: number
  userId: number
  name: string
  description: string
  status: "completed" | "active" | "failed"
  metadata: any
  rootWorkflowStepExeId: string
  completedBy: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

interface WorkflowExecutionsResponse {
  data: ApiWorkflowExecution[]
  pagination: {
    page: number
    limit: number
    totalCount: string
    totalPages: number
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
  filters: {
    id: string | null
    name: string | null
    from_date: string
    to_date: string
  }
}

// Helper function to extract data from Hono client response
async function extractResponseData<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: "Network error" }))
    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
  }

  const responseData = await response.json()
  
  // Extract data from success wrapper if present
  if (responseData.success && responseData.data !== undefined) {
    return responseData.data as T
  }
  
  // If no success wrapper, return the response with success flag removed
  if (responseData.success !== undefined) {
    const { success, ...rest } = responseData
    return rest as T
  }
  
  return responseData as T
}

// Workflow Templates API
export const workflowTemplatesAPI = {
  /**
   * Fetch a specific workflow template by ID
   */
  async fetchById(id: string): Promise<TemplateFlow> {
    const response = await api.workflow.templates[id].$get()
    return extractResponseData<TemplateFlow>(response)
  },

  /**
   * Instantiate a workflow template
   */
  async instantiate(
    id: string,
    options: { name: string; metadata?: any },
  ): Promise<{ workflowId: string; rootStepId: string }> {
    const response = await api.workflow.templates[id].execute.$post({
      json: options,
    })
    return extractResponseData<{ workflowId: string; rootStepId: string }>(response)
  },
}

// Workflows API
export const workflowsAPI = {
  /**
   * Fetch a specific workflow by ID
   */
  async fetchById(id: string): Promise<Flow> {
    const response = await api.workflow.executions[id].$get()
    return extractResponseData<Flow>(response)
  },

  /**
   * Run a workflow
   */
  async run(id: string): Promise<any> {
    const response = await api.workflow.executions[id].$post({ json: {} })
    return extractResponseData<any>(response)
  },

  /**
   * Complete a workflow step
   */
  async completeStep(stepId: string): Promise<any> {
    const response = await api.workflow.steps[stepId].complete.$post()
    return extractResponseData<any>(response)
  },
}

// Workflow Templates API (for "Your Workflows" section)
export const userWorkflowsAPI = {
  /**
   * Fetch workflow templates
   */
  async fetchWorkflows(): Promise<WorkflowTemplateResponse> {
    const response = await api.workflow.templates.$get()
    const data = await extractResponseData<WorkflowTemplate[]>(response)
    return { data }
  },

  /**
   * Fetch a specific workflow template by ID
   */
  async fetchTemplateById(templateId: string): Promise<WorkflowTemplate> {
    const response = await api.workflow.templates[templateId].$get()
    return extractResponseData<WorkflowTemplate>(response)
  },

  /**
   * Create a complex workflow template from workflow builder
   */
  async createComplexTemplate(workflowData: {
    name: string
    description: string
    version?: string
    config?: any
    nodes: any[]
    edges: any[]
    metadata?: any
  }): Promise<WorkflowTemplate> {
    const response = await api.workflow.templates.complex.$post({
      json: workflowData,
    })
    return extractResponseData<WorkflowTemplate>(response)
  },
}

// Templates API
export const templatesAPI = {
  /**
   * Fetch all templates
   */
  async fetchAll(): Promise<ApiTemplate[]> {
    // Use the workflow templates endpoint via Hono client
    const response = await api.workflow.templates.$get()
    return extractResponseData<ApiTemplate[]>(response)
  },
}


// Workflow Executions API
export const workflowExecutionsAPI = {
  /**
   * Fetch workflow executions with filters using query parameters
   */
  async fetchAll(params: {
    limit: number
    page: number
    from_date?: string
    to_date?: string
    name?: string
    id?: string
  }): Promise<WorkflowExecutionsResponse> {
    const query: Record<string, string> = {
      limit: params.limit.toString(),
      page: params.page.toString(),
    }

    if (params.from_date) query.from_date = params.from_date
    if (params.to_date) query.to_date = params.to_date
    if (params.name) query.name = params.name
    if (params.id) query.id = params.id

    const response = await api.workflow.executions.$get({ query })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: "Network error" }))
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
    }

    const responseData = await response.json()
    
    // For workflow executions, we need to return the complete response structure 
    // (success, data, pagination, filters) as the frontend expects these properties
    if (responseData.success !== undefined) {
      return responseData as WorkflowExecutionsResponse
    }
    
    return responseData as WorkflowExecutionsResponse
  },

  /**
   * Fetch workflow execution status by execution ID
   */
  async fetchStatus(executionId: string): Promise<{
    success: boolean
    status: "draft" | "active" | "paused" | "completed" | "failed"
  }> {
    const response = await api.workflow.executions[executionId].status.$get()
    return extractResponseData<{
      success: boolean
      status: "draft" | "active" | "paused" | "completed" | "failed"
    }>(response)
  },

  /**
   * Fetch full workflow execution details by execution ID
   */
  async fetchById(executionId: string): Promise<any> {
    const response = await api.workflow.executions[executionId].$get()
    return extractResponseData<any>(response)
  },

  /**
   * Execute workflow template with input data and file
   */
  async executeTemplate(
    templateId: string,
    executionData: {
      name: string
      description: string
      file?: File
      formData: Record<string, any>
    },
  ): Promise<any> {
    const formData = new FormData()

    // Add required fields matching the curl command
    formData.append("name", executionData.name)
    formData.append("description", executionData.description)

    // Add additional form data fields (excluding name and description to avoid duplicates)
    Object.entries(executionData.formData).forEach(([key, value]) => {
      if (key !== "name" && key !== "description") {
        if (value instanceof File) {
          formData.append("document_file", value)
        } else {
          formData.append(key, String(value))
        }
      }
    })

    // Additional fallback: If no file has been added yet, check if we need to add the main file as document_file
    let hasDocumentFile = false
    for (const [key] of formData.entries()) {
      if (key === "document_file") {
        hasDocumentFile = true
        break
      }
    }

    if (!hasDocumentFile && executionData.file) {
      formData.append("document_file", executionData.file)
    }
    // Use direct fetch for file uploads as Hono client may not handle FormData correctly
    const response = await fetch(
      `/api/v1/workflow/templates/${templateId}/execute-with-input`,
      {
        method: "POST",
        body: formData,
        credentials: "include", // This ensures cookies are sent for authentication
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: "Network error" }))
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
    }

    const responseData = await response.json()
    
    // Extract data from success wrapper if present
    if (responseData.success && responseData.data !== undefined) {
      return responseData.data
    }
    
    // If no success wrapper, return the response with success flag removed
    if (responseData.success !== undefined) {
      const { success, ...rest } = responseData
      return rest
    }
    
    return responseData
  },
}

// Workflow Tools API for editing tools
export const workflowToolsAPI = {
  /**
   * Get a workflow tool by ID
   */
  async getTool(toolId: string): Promise<any> {
    const response = await api.workflow.tools[toolId].$get()
    return extractResponseData<any>(response)
  },

  /**
   * Update a workflow tool
   */
  async updateTool(
    toolId: string,
    toolData: {
      type: string
      value: any
      config: any
    },
  ): Promise<any> {
    const response = await api.workflow.tools[toolId].$put({
      json: toolData,
    })
    return extractResponseData<any>(response)
  },

  /**
   * Create a new workflow tool
   */
  async createTool(toolData: {
    type: string
    value: any
    config: any
  }): Promise<any> {
    const response = await api.workflow.tools.$post({
      json: toolData,
    })
    return extractResponseData<any>(response)
  },

  /**
   * Save webhook configuration to workflow_tool table
   */
  async saveWebhookConfig(webhookConfig: {
    webhookUrl: string
    httpMethod: string
    path: string
    authentication: string
    selectedCredential?: string
    responseMode: string
    headers?: Record<string, string>
    queryParams?: Record<string, string>
    options?: Record<string, any>
    requestBody?: string
  }): Promise<any> {
    console.log("🔗 Starting webhook save process...")
    console.log("📋 Webhook config input:", webhookConfig)

    // Format credential data for backend storage
    const formatCredentialData = async () => {
      console.log("🔐 Formatting credential data...")
      if (webhookConfig.authentication === "none") {
        console.log("ℹ️ No authentication, returning empty array")
        return []
      }

      try {
        // Fetch all credentials of the required type
        console.log("🔍 Fetching all credentials for auth type:", webhookConfig.authentication)
        const allCredentials = await credentialsAPI.fetchByType(webhookConfig.authentication as "basic" | "bearer" | "api_key")

        if (allCredentials.length === 0) {
          console.log("ℹ️ No credentials found for this auth type")
          return []
        }

        console.log(`✅ Found ${allCredentials.length} credentials of type ${webhookConfig.authentication}`)

        // Map all credentials with isSelected flag based on selectedCredential
        const credentialData = allCredentials.map(credential => {
          const isSelected = credential.id === webhookConfig.selectedCredential

          // Create base64 encoding of user:password for basic auth
          const basicAuth = btoa(`${credential.user}:${credential.password}`)

          console.log(`📋 Processing credential: ${credential.name}, isSelected: ${isSelected}`)

          return {
            user: credential.user,
            password: credential.password, // Note: In production, this should be encrypted
            basic_auth: basicAuth,
            isSelected,
            name: credential.name,
            allowedDomains: credential.allowedDomains
          }
        })

        console.log("📦 Formatted credential data with all credentials:", credentialData)
        return credentialData
      } catch (error) {
        console.error("❌ Error formatting credential data:", error)
        return []
      }
    }

    const credentialArray = await formatCredentialData()

    // Prepare data for workflow_tool table
    const toolData = {
      type: "webhook",
      value: {
        // Store webhook URL and path in value column
        webhookUrl: webhookConfig.webhookUrl,
        path: webhookConfig.path,
        httpMethod: webhookConfig.httpMethod,
        requestBody: webhookConfig.requestBody,
        title: `Webhook: ${webhookConfig.path}`,
        description: `${webhookConfig.httpMethod} ${webhookConfig.webhookUrl} • ${
          webhookConfig.authentication === 'none' ? 'No authentication' : 'Basic authentication'
        }`
      },
      config: {
        // Store behavior configuration in config column
        authentication: webhookConfig.authentication,
        responseMode: webhookConfig.responseMode,
        headers: webhookConfig.headers || {},
        queryParams: webhookConfig.queryParams || {},
        options: webhookConfig.options || {},
        requestBody: webhookConfig.requestBody,
        credentials: credentialArray, // Array of credential objects with base64 auth
        selectedCredential: webhookConfig.selectedCredential
      }
    }

    console.log("📋 Final tool data to send to backend:", JSON.stringify(toolData, null, 2))

    try {
      // Check if webhook type is supported by the backend
      console.log("🚀 Attempting to create tool with backend API...")
      const response = await this.createTool(toolData)
      console.log("✅ Backend response:", response)
      return response
    } catch (error) {
      console.error("❌ Backend API error:", error)

      // Check if it's a validation error for unsupported tool type
      if (error instanceof Error && error.message.includes("webhook")) {
        console.log("⚠️ Backend doesn't support 'webhook' tool type yet")
        console.log("🔄 This is expected during development - webhook type needs to be added to backend validation")

        // For now, return a mock response to unblock frontend development
        const mockResponse = {
          id: `mock-webhook-${Date.now()}`,
          type: "webhook",
          value: toolData.value,
          config: toolData.config,
          createdAt: new Date().toISOString(),
          note: "Mock response - backend needs webhook tool type support"
        }

        console.log("🔧 Returning mock response for development:", mockResponse)
        return mockResponse
      }

      // Re-throw other errors
      throw error
    }
  },

  /**
   * Test Jira connection
   */
  async testJiraConnection(credentials: {
    domain: string
    email: string
    apiToken: string
  }): Promise<{ success: boolean; message: string }> {
    try {
      const response = await api.workflow.tools.jira['test-connection'].$post({
        json: credentials,
      })

      // Don't use extractResponseData here - we need to preserve the success flag
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Network error" }))
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("❌ Jira connection test failed:", error)
      throw error
    }
  },

  /**
   * Register Jira webhook
   */
  async registerJiraWebhook(config: {
    domain: string
    email: string
    apiToken: string
    webhookUrl: string
    events: string[]
    name?: string
    filters?: { jqlFilter?: string }
  }): Promise<{ success: boolean; webhookId: string; message: string }> {
    try {
      const response = await api.workflow.tools.jira['register-webhook'].$post({
        json: config,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Network error" }))
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("❌ Jira webhook registration failed:", error)
      throw error
    }
  },

  /**
   * Update existing webhook configuration
   */
  async updateWebhookConfig(
    toolId: string,
    webhookConfig: {
      webhookUrl: string
      httpMethod: string
      path: string
      authentication: string
      selectedCredential?: string
      responseMode: string
      headers?: Record<string, string>
      queryParams?: Record<string, string>
      options?: Record<string, any>
      requestBody?: string
    }
  ): Promise<any> {
    // Format credential data for backend storage
    const formatCredentialData = async () => {
      if (webhookConfig.authentication === "none") {
        return []
      }

      try {
        // Fetch all credentials of the required type
        const allCredentials = await credentialsAPI.fetchByType(webhookConfig.authentication as "basic" | "bearer" | "api_key")

        if (allCredentials.length === 0) {
          return []
        }

        // Map all credentials with isSelected flag based on selectedCredential
        const credentialData = allCredentials.map(credential => {
          const isSelected = credential.id === webhookConfig.selectedCredential

          // Create base64 encoding of user:password for basic auth
          const basicAuth = btoa(`${credential.user}:${credential.password}`)

          return {
            user: credential.user,
            password: credential.password, // Note: In production, this should be encrypted
            basic_auth: basicAuth,
            isSelected,
            name: credential.name,
            allowedDomains: credential.allowedDomains
          }
        })

        return credentialData
      } catch (error) {
        console.error("Error formatting credential data:", error)
        return []
      }
    }

    const credentialArray = await formatCredentialData()

    // Prepare data for workflow_tool table
    const toolData = {
      type: "webhook",
      value: {
        // Store webhook URL and path in value column
        webhookUrl: webhookConfig.webhookUrl,
        path: webhookConfig.path,
        httpMethod: webhookConfig.httpMethod,
        requestBody: webhookConfig.requestBody,
        title: `Webhook: ${webhookConfig.path}`,
        description: `${webhookConfig.httpMethod} ${webhookConfig.webhookUrl} • ${
          webhookConfig.authentication === 'none' ? 'No authentication' : 'Basic authentication'
        }`
      },
      config: {
        // Store behavior configuration in config column
        authentication: webhookConfig.authentication,
        responseMode: webhookConfig.responseMode,
        headers: webhookConfig.headers || {},
        queryParams: webhookConfig.queryParams || {},
        options: webhookConfig.options || {},
        requestBody: webhookConfig.requestBody,
        credentials: credentialArray, // Array of credential objects with base64 auth
        selectedCredential: webhookConfig.selectedCredential
      }
    }

    const response = await this.updateTool(toolId, toolData)
    return response
  },

  /**
   * Save HTTP request configuration to workflow_tool table
   */
  async saveHttpRequestConfig(httpConfig: {
    url: string
    method: string
    headers?: Record<string, string>
    queryParams?: Record<string, string>
    body?: string
    bodyType?: string
    authentication?: string
    authConfig?: Record<string, any>
    timeout?: number
    followRedirects?: boolean
    title?: string
  }): Promise<any> {
    console.log("🌐 Starting HTTP request save process...")
    console.log("📋 HTTP config input:", httpConfig)

    // Prepare data for workflow_tool table
    const toolData = {
      type: "http_request",
      value: {
        // Store main configuration in value column
        url: httpConfig.url,
        method: httpConfig.method,
        headers: httpConfig.headers || {},
        queryParams: httpConfig.queryParams || {},
        body: httpConfig.body,
        bodyType: httpConfig.bodyType,
        title: httpConfig.title || `${httpConfig.method} ${httpConfig.url}`,
        description: `${httpConfig.method} ${httpConfig.url}${httpConfig.authentication && httpConfig.authentication !== 'none' ? ` • ${httpConfig.authentication} auth` : ''}`
      },
      config: {
        // Store authentication and advanced options in config column
        authentication: httpConfig.authentication || "none",
        authConfig: httpConfig.authConfig || {},
        timeout: httpConfig.timeout || 30000,
        followRedirects: httpConfig.followRedirects !== false,
      }
    }

    console.log("📋 Final tool data to send to backend:", JSON.stringify(toolData, null, 2))

    try {
      console.log("🚀 Attempting to create HTTP request tool with backend API...")
      const response = await this.createTool(toolData)
      console.log("✅ Backend response:", response)
      return response
    } catch (error) {
      console.error("❌ Backend API error:", error)

      // Check if it's a validation error for unsupported tool type
      if (error instanceof Error && error.message.includes("http_request")) {
        console.log("⚠️ Backend doesn't support 'http_request' tool type yet")
        console.log("🔄 This is expected during development - http_request type needs to be added to backend validation")

        // For now, return a mock response to unblock frontend development
        const mockResponse = {
          id: `mock-http-request-${Date.now()}`,
          type: "http_request",
          value: toolData.value,
          config: toolData.config,
          createdAt: new Date().toISOString(),
          note: "Mock response - backend needs http_request tool type support"
        }

        console.log("🔧 Returning mock response for development:", mockResponse)
        return mockResponse
      }

      // Re-throw other errors
      throw error
    }
  },

  /**
   * Get all Jira webhooks
   */
  async getJiraWebhooks(credentials: {
    domain: string
    email: string
    apiToken: string
  }): Promise<{ success: boolean; data: any[]; count: number }> {
    try {
      const response = await api.workflow.tools.jira.webhooks.$post({
        json: credentials,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Network error" }))
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("❌ Failed to get Jira webhooks:", error)
      throw error
    }
  },

  /**
   * Delete Jira webhook
   */
  async deleteJiraWebhook(config: {
    domain: string
    email: string
    apiToken: string
    webhookId: string
  }): Promise<{ success: boolean; message: string }> {
    try {
      const response = await api.workflow.tools.jira['delete-webhook'].$post({
        json: config,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Network error" }))
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      return await response.json()
    } catch (error) {
      console.error("❌ Failed to delete Jira webhook:", error)
      throw error
    }
  },

  /**
   * Fetch Jira metadata for dynamic dropdowns
   */
  async fetchJiraMetadata(config: {
    domain: string
    email: string
    apiToken: string
    projectKeys?: string[]
  }): Promise<{
    projects: Array<{ key: string; name: string; id: string }>
    priorities: Array<{ id: string; name: string }>
    statuses: Array<{ id: string; name: string }>
    issueTypes: Array<{ id: string; name: string }>
    epics: Array<{ key: string; summary: string; projectKey?: string }>
    components: Array<{ id: string; name: string }>
    issues: Array<{ key: string; summary: string; status?: string; issuetype?: string; priority?: string }>
  }> {
    try {
      const response = await api.workflow.tools.jira.metadata.$post({
        json: config,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: "Network error" }))
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      const result = await response.json()
      return result.data
    } catch (error) {
      console.error("❌ Failed to fetch Jira metadata:", error)
      throw error
    }
  },

  /**
   * Save Jira configuration to workflow_tool table
   */
  async saveJiraConfig(jiraConfig: {
    domain: string
    email: string
    apiToken: string
    events: string[]
    webhookUrl?: string
    testWebhookUrl?: string
    productionWebhookUrl?: string
    webhookId?: string
    title?: string
    description?: string
    jqlFilter?: string
    simpleFilters?: {
      projects?: string[]
      issueTypes?: string[]
      priorities?: string[]
      statuses?: string[]
      epics?: string[]
      issues?: string[]
    }
  }): Promise<any> {
    // Prepare data for workflow_tool table
    const toolData = {
      type: "jira",
      value: {
        // Store webhook URLs and metadata in value column
        webhookUrl: jiraConfig.productionWebhookUrl || jiraConfig.webhookUrl,
        testWebhookUrl: jiraConfig.testWebhookUrl,
        productionWebhookUrl: jiraConfig.productionWebhookUrl,
        webhookId: jiraConfig.webhookId,
        title: jiraConfig.title || 'Jira Trigger',
        description: jiraConfig.description || `Jira webhook for events: ${jiraConfig.events.join(', ')}`,
        events: jiraConfig.events,
        jqlFilter: jiraConfig.jqlFilter,
        simpleFilters: jiraConfig.simpleFilters,
      },
      config: {
        // Store Jira credentials and webhookId in config column for reliable matching
        domain: jiraConfig.domain,
        email: jiraConfig.email,
        apiToken: jiraConfig.apiToken,
        webhookId: jiraConfig.webhookId, // Store in both config and value for reliable matching
        events: jiraConfig.events,
        productionWebhookUrl: jiraConfig.productionWebhookUrl,
        testWebhookUrl: jiraConfig.testWebhookUrl,
      }
    }

    try {
      const response = await this.createTool(toolData)
      return response
    } catch (error) {
      console.error("Failed to create Jira tool:", error instanceof Error ? error.message : error)
      throw error
    }
  },

  /**
   * Update existing HTTP request configuration
   */
  async updateHttpRequestConfig(
    toolId: string,
    httpConfig: {
      url: string
      method: string
      headers?: Record<string, string>
      queryParams?: Record<string, string>
      body?: string
      bodyType?: string
      authentication?: string
      authConfig?: Record<string, any>
      timeout?: number
      followRedirects?: boolean
      title?: string
    }
  ): Promise<any> {
    console.log("🌐 Updating HTTP request configuration...")
    console.log("📋 HTTP config input:", httpConfig)

    // Prepare data for workflow_tool table
    const toolData = {
      type: "http_request",
      value: {
        url: httpConfig.url,
        method: httpConfig.method,
        headers: httpConfig.headers || {},
        queryParams: httpConfig.queryParams || {},
        body: httpConfig.body,
        bodyType: httpConfig.bodyType,
        title: httpConfig.title || `${httpConfig.method} ${httpConfig.url}`,
        description: `${httpConfig.method} ${httpConfig.url}${httpConfig.authentication && httpConfig.authentication !== 'none' ? ` • ${httpConfig.authentication} auth` : ''}`
      },
      config: {
        authentication: httpConfig.authentication || "none",
        authConfig: httpConfig.authConfig || {},
        timeout: httpConfig.timeout || 30000,
        followRedirects: httpConfig.followRedirects !== false,
      }
    }

    console.log("📋 Final tool data to send to backend:", JSON.stringify(toolData, null, 2))

    try {
      const response = await this.updateTool(toolId, toolData)
      console.log("✅ HTTP request configuration updated:", response)
      return response
    } catch (error) {
      console.error("❌ Failed to update HTTP request configuration:", error)

      // For development, return a mock response if the backend doesn't support it yet
      if (error instanceof Error && error.message.includes("http_request")) {
        const mockResponse = {
          id: toolId,
          type: "http_request",
          value: toolData.value,
          config: toolData.config,
          updatedAt: new Date().toISOString(),
          note: "Mock response - backend needs http_request tool type support"
        }

        console.log("🔧 Returning mock response for development:", mockResponse)
        return mockResponse
      }

      throw error
    }
  },

  /**
   * Update existing Jira configuration
   */
  async updateJiraConfig(
    toolId: string,
    jiraConfig: {
      domain: string
      email: string
      apiToken: string
      events: string[]
      webhookUrl?: string
      testWebhookUrl?: string
      productionWebhookUrl?: string
      webhookId?: string
      title?: string
      description?: string
      jqlFilter?: string
      simpleFilters?: {
        projects?: string[]
        issueTypes?: string[]
        priorities?: string[]
        statuses?: string[]
        epics?: string[]
        issues?: string[]
      }
    }
  ): Promise<any> {
    // Prepare data for workflow_tool table
    const toolData = {
      type: "jira",
      value: {
        // Store webhook URLs and metadata in value column
        webhookUrl: jiraConfig.productionWebhookUrl || jiraConfig.webhookUrl,
        testWebhookUrl: jiraConfig.testWebhookUrl,
        productionWebhookUrl: jiraConfig.productionWebhookUrl,
        webhookId: jiraConfig.webhookId,
        title: jiraConfig.title || 'Jira Trigger',
        description: jiraConfig.description || `Jira webhook for events: ${jiraConfig.events.join(', ')}`,
        events: jiraConfig.events,
        jqlFilter: jiraConfig.jqlFilter,
        simpleFilters: jiraConfig.simpleFilters,
      },
      config: {
        // Store Jira credentials and webhookId in config column for reliable matching
        domain: jiraConfig.domain,
        email: jiraConfig.email,
        apiToken: jiraConfig.apiToken,
        webhookId: jiraConfig.webhookId, // Store in both config and value for reliable matching
        events: jiraConfig.events,
        productionWebhookUrl: jiraConfig.productionWebhookUrl,
        testWebhookUrl: jiraConfig.testWebhookUrl,
      }
    }

    try {
      const response = await this.updateTool(toolId, toolData)
      return response
    } catch (error) {
      console.error("Failed to update Jira tool:", error instanceof Error ? error.message : error)
      throw error
    }
  },
}

// Workflow Steps API for adding and editing steps
export const workflowStepsAPI = {
  /**
   * Create a new step in a workflow template with inline tool creation
   */
  async createStep(
    templateId: string,
    stepData: {
      name: string
      description: string
      type: string
      tool: {
        type: string
        value: any
        config: any
      }
      parentStepId?: string
      prevStepIds?: string[]
      nextStepIds?: string[]
      timeEstimate?: number
      metadata?: any
    },
  ): Promise<any> {
    const response = await api.workflow.templates[templateId].steps.$post({
      json: stepData,
    })
    return extractResponseData<any>(response)
  },

  /**
   * Update an existing step
   */
  async updateStep(
    stepId: string,
    stepData: {
      name?: string
      description?: string
      type?: string
      parentStepId?: string
      prevStepIds?: string[]
      nextStepIds?: string[]
      toolIds?: string[]
      timeEstimate?: number
      metadata?: any
    },
  ): Promise<any> {
    const response = await api.workflow.steps[stepId].$put({
      json: stepData,
    })
    return extractResponseData<any>(response)
  },

  /**
   * Link a step to another step (add to nextStepIds)
   */
  async linkSteps(_sourceStepId: string, _targetStepId: string): Promise<any> {
    // Note: This specific endpoint doesn't exist in current routes
    // You may need to use updateStep to modify nextStepIds instead
    throw new Error("linkSteps endpoint not available in current API. Use updateStep to modify nextStepIds.")
  },
}

// Mock credentials state for development/testing
let mockCredentials: Credential[] = []

// Credentials API
export const credentialsAPI = {
  /**
   * Fetch all credentials for the current user
   */
  async fetchAll(): Promise<Credential[]> {
    try {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 300))
      return [...mockCredentials] // Return a copy to prevent external modification
    } catch (error) {
      console.error('Failed to fetch credentials:', error)
      return []
    }
  },

  /**
   * Fetch credentials by type
   */
  async fetchByType(type: "basic" | "bearer" | "api_key"): Promise<Credential[]> {
    const allCredentials = await this.fetchAll()
    return allCredentials.filter(cred => cred.type === type)
  },

  /**
   * Create a new credential
   */
  async create(credentialData: {
    name: string
    type: "basic" | "bearer" | "api_key"
    user?: string
    password?: string
    token?: string
    apiKey?: string
    allowedDomains?: string
  }): Promise<Credential> {
    try {
      const newCredential: Credential = {
        id: Date.now().toString(),
        ...credentialData,
        isValid: true,
        createdBy: "current-user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // Add to mock state
      mockCredentials.push(newCredential)

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 500))

      return newCredential
    } catch (error) {
      console.error('Failed to create credential:', error)
      throw error
    }
  },

  /**
   * Update an existing credential
   */
  async update(credentialId: string, updates: Partial<Credential>): Promise<Credential> {
    try {
      const credentialIndex = mockCredentials.findIndex(cred => cred.id === credentialId)
      
      if (credentialIndex === -1) {
        throw new Error(`Credential with ID ${credentialId} not found`)
      }

      const updatedCredential: Credential = {
        ...mockCredentials[credentialIndex],
        ...updates,
        id: credentialId, // Ensure ID doesn't get overwritten
        updatedAt: new Date().toISOString(),
      }

      // Update in mock state
      mockCredentials[credentialIndex] = updatedCredential

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 500))

      return updatedCredential
    } catch (error) {
      console.error('Failed to update credential:', error)
      throw error
    }
  },

  /**
   * Delete a credential
   */
  async delete(credentialId: string): Promise<void> {
    try {
      const credentialIndex = mockCredentials.findIndex(cred => cred.id === credentialId)
      
      if (credentialIndex === -1) {
        throw new Error(`Credential with ID ${credentialId} not found`)
      }

      // Remove from mock state
      mockCredentials.splice(credentialIndex, 1)

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 300))

      console.log(`Credential ${credentialId} deleted`)
    } catch (error) {
      console.error('Failed to delete credential:', error)
      throw error
    }
  },

  /**
   * Test credential validity
   */
  async testCredential(credentialId: string): Promise<{ isValid: boolean; message?: string }> {
    try {
      const credential = mockCredentials.find(cred => cred.id === credentialId)
      
      if (!credential) {
        throw new Error(`Credential with ID ${credentialId} not found`)
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
      
      // Use the credential's isValid property
      const isValid = credential.isValid || false
      
      return {
        isValid,
        message: isValid ? "Credential is valid" : "Credential authentication failed"
      }
    } catch (error) {
      console.error('Failed to test credential:', error)
      return { isValid: false, message: "Failed to test credential" }
    }
  }
}
