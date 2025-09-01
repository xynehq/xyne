import { Flow, TemplateFlow } from '../Types';

// API response types
interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

// Base URL for workflow service
const WORKFLOW_BASE_URL = 'https://53b79c6d27eb.ngrok-free.app/v1';

// Generic API request handler with ngrok headers
async function apiRequest<T>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'Accept': 'application/json',
        ...options?.headers,
      },
      ...options,
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        error: data.message || `HTTP ${response.status}: ${response.statusText}`,
        status: response.status,
      };
    }

    return {
      data,
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Network error',
      status: 0,
    };
  }
}

// Workflow Templates API
export const workflowTemplatesAPI = {

  /**
   * Fetch a specific workflow template by ID
   */
  async fetchById(id: string): Promise<ApiResponse<TemplateFlow>> {
    return apiRequest<TemplateFlow>(`${WORKFLOW_BASE_URL}/workflow-template/${id}`);
  },

  /**
   * Instantiate a workflow template
   */
  async instantiate(id: string, options: { name: string; metadata?: any }): Promise<ApiResponse<{ workflowId: string; rootStepId: string }>> {
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
  async fetchById(id: string): Promise<ApiResponse<Flow>> {
    return apiRequest<Flow>(`${WORKFLOW_BASE_URL}/workflow/${id}`);
  },

  /**
   * Run a workflow
   */
  async run(id: string): Promise<ApiResponse<any>> {
    return apiRequest<any>(`${WORKFLOW_BASE_URL}/workflow/${id}/run`, {
      method: 'POST',
    });
  },

  /**
   * Complete a workflow step
   */
  async completeStep(stepId: string): Promise<ApiResponse<any>> {
    return apiRequest<any>(`${WORKFLOW_BASE_URL}/workflow/step/${stepId}/complete`, {
      method: 'POST',
    });
  },
};