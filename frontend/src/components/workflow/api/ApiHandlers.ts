import { Flow, TemplateFlow } from '../Types';

// API request/response types for workflow templates

interface WorkflowTemplateResponse{
  data: WorkflowTemplate[];
}
interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  status: string;
  config: {
    ai_model?: string;
    max_file_size?: string;
    auto_execution?: boolean;
    schema_version?: string;
    allowed_file_types?: string[];
    supports_file_upload?: boolean;
  };
  createdBy: string;
  rootWorkflowStepTemplateId: string;
  createdAt: string;
  updatedAt: string;
  rootStep?: {
    id: string;
    workflowTemplateId: string;
    name: string;
    description: string;
    type: string;
    timeEstimate: number;
    metadata: {
      icon?: string;
      step_order?: number;
      schema_version?: string;
      user_instructions?: string;
    };
    tool?: {
      id: string;
      type: string;
      value: any;
      config: any;
      createdBy: string;
      createdAt: string;
      updatedAt: string;
    };
  };
}

interface ApiTemplate {
  id: number;
  workspaceId: string;
  name: string;
  description: string;
  version: string;
  status: string;
  config: {
    steps?: Array<{
      id: number;
      name: string;
      type: string;
    }>;
    features?: string[];
    description?: string;
    steps_count?: number;
    ai_model?: string;
    max_file_size?: string;
    allowed_file_types?: string[];
    supports_file_upload?: boolean;
    auto_execution?: boolean;
  };
  createdBy: string;
  rootWorkflowStepTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ApiWorkflowExecution {
  id: string;
  workflowTemplateId: string;
  name: string;
  description: string;
  status: 'completed' | 'active' | 'failed';
  metadata: any;
  rootWorkflowStepExeId: string;
  createdBy: string;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface WorkflowExecutionsResponse {
  data: ApiWorkflowExecution[];
  pagination: {
    page: number;
    limit: number;
    totalCount: string;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  filters: {
    id: string | null;
    name: string | null;
    from_date: string;
    to_date: string;
  };
}



// Base URL for workflow service
const WORKFLOW_BASE_URL = 'https://2f66b479bc76.ngrok-free.app/v1';

// Base URL for workflow templates
const WORKFLOW_TEMPLATES_BASE_URL = 'https://2f66b479bc76.ngrok-free.app/api/v1';

// Base URL for user service  
const USER_SERVICE_BASE_URL = 'https://2f66b479bc76.ngrok-free.app';

// Base URL for workflow execution
const WORKFLOW_EXECUTION_BASE_URL = 'https://2f66b479bc76.ngrok-free.app/api/v1';

// Generic API request handler with ngrok headers
async function apiRequest<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'Access-Control-Allow-Origin': '*',
        ...options?.headers,
      },
      mode: 'cors',
      ...options,
    });

    const responseData = await response.json();

    if (!response.ok) {
      throw new Error(responseData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    // Preserve full response structure while extracting from success wrapper
    // If API returns: { success: true, data: {...}, pagination: {...}, filters: {...} }
    // Extract everything except the success flag
    let extractedData;
    if (responseData.success) {
      // Remove the success flag and return the rest of the response
      const { success, ...rest } = responseData;
      extractedData = rest;
    } else {
      extractedData = responseData;
    }

    return extractedData;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Network error');
  }
}


// FormData API request handler for file uploads
async function apiFormRequest<T>(
  url: string,
  formData: FormData
): Promise<T> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'ngrok-skip-browser-warning': 'true',
        'Access-Control-Allow-Origin': '*',
        // Don't set Content-Type for FormData - browser will set it with boundary
      },
      mode: 'cors',
      body: formData,
    });

    const responseData = await response.json();

    if (!response.ok) {
      throw new Error(responseData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    // Return the complete response data
    return responseData;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Network error');
  }
}

// Workflow Templates API
export const workflowTemplatesAPI = {

  /**
   * Fetch a specific workflow template by ID
   */
  async fetchById(id: string): Promise<TemplateFlow> {
    return apiRequest<TemplateFlow>(`${WORKFLOW_BASE_URL}/workflow-template/${id}`);
  },

  /**
   * Instantiate a workflow template
   */
  async instantiate(id: string, options: { name: string; metadata?: any }): Promise<{ workflowId: string; rootStepId: string }> {
    return apiRequest<{ workflowId: string; rootStepId: string }>(`${WORKFLOW_BASE_URL}/workflow-template/${id}/instantiate`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },
};

// Workflows API
export const workflowsAPI = {

  /**
   * Fetch a specific workflow by ID
   */
  async fetchById(id: string): Promise<Flow> {
    return apiRequest<Flow>(`${WORKFLOW_BASE_URL}/workflow/${id}`);
  },

  /**
   * Run a workflow
   */
  async run(id: string): Promise<any> {
    return apiRequest<any>(`${WORKFLOW_BASE_URL}/workflow/${id}/run`, {
      method: 'POST',
    });
  },

  /**
   * Complete a workflow step
   */
  async completeStep(stepId: string): Promise<any> {
    return apiRequest<any>(`${WORKFLOW_BASE_URL}/workflow/step/${stepId}/complete`, {
      method: 'POST',
    });
  },
};

// Workflow Templates API (for "Your Workflows" section)
export const userWorkflowsAPI = {
  /**
   * Fetch workflow templates
   */
  async fetchWorkflows(): Promise<WorkflowTemplateResponse> {
    return apiRequest<WorkflowTemplateResponse>(`${WORKFLOW_TEMPLATES_BASE_URL}/workflow/templates`);
  },

  /**
   * Fetch a specific workflow template by ID
   */
  async fetchTemplateById(templateId: string): Promise<WorkflowTemplate> {
    return apiRequest<WorkflowTemplate>(`${WORKFLOW_TEMPLATES_BASE_URL}/workflow/templates/${templateId}`);
  },
};

// Templates API
export const templatesAPI = {
  /**
   * Fetch all templates
   */
  async fetchAll(): Promise<ApiTemplate[]> {
    return apiRequest<ApiTemplate[]>(`${USER_SERVICE_BASE_URL}/template/fetch/all`);
  },
};

// Workflow Executions API
export const workflowExecutionsAPI = {
  /**
   * Fetch workflow executions with filters using query parameters
   */
  async fetchAll(params: {
    limit: number;
    page: number;
    from_date?: string;
    to_date?: string;
    name?: string;
    id?: string;
  }): Promise<WorkflowExecutionsResponse> {
    // Build query string from parameters
    const queryParams = new URLSearchParams();
    queryParams.append('limit', params.limit.toString());
    queryParams.append('page', params.page.toString());
    
    if (params.from_date) {
      queryParams.append('from_date', params.from_date);
    }
    if (params.to_date) {
      queryParams.append('to_date', params.to_date);
    }
    if (params.name) {
      queryParams.append('name', params.name);
    }
    if (params.id) {
      queryParams.append('id', params.id);
    }
    
    const url = `${WORKFLOW_EXECUTION_BASE_URL}/workflow/executions?${queryParams.toString()}`;
    return apiRequest<WorkflowExecutionsResponse>(url);
  },

  /**
   * Execute workflow template with input data and file
   */
  async executeTemplate(templateId: string, executionData: {
    name: string;
    description: string;
    file?: File;
    formData: Record<string, any>;
  }): Promise<any> {
    const formData = new FormData();
    
    // Add required fields matching the curl command
    formData.append('name', executionData.name);
    formData.append('description', executionData.description);
    
    // Add the uploaded file if provided
    if (executionData.file) {
      formData.append('document_file', executionData.file);
    }
    
    // Add additional form data fields (excluding name and description to avoid duplicates)
    Object.entries(executionData.formData).forEach(([key, value]) => {
      if (key !== 'name' && key !== 'description') {
        formData.append(key, String(value));
      }
    });
    
    return apiFormRequest<any>(`${WORKFLOW_EXECUTION_BASE_URL}/workflow/templates/${templateId}/execute-with-input`, formData);
  },
};