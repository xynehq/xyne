import { Flow, TemplateFlow } from "../Types"
import { api } from "../../../api"

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
  id: number
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
