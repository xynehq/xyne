import { WorkflowTemplate, Flow } from '../Types';
import { API_ENDPOINTS } from './Endpoints';

// API response types
interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

// Generic API request handler
async function apiRequest<T>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
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
   * Fetch all workflow templates
   */
  async fetchAll(): Promise<ApiResponse<WorkflowTemplate[]>> {
    return apiRequest<WorkflowTemplate[]>(API_ENDPOINTS.WORKFLOW_TEMPLATES);
  },

  /**
   * Create a new workflow template
   */
  async create(template: Omit<WorkflowTemplate, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse<WorkflowTemplate>> {
    return apiRequest<WorkflowTemplate>(API_ENDPOINTS.WORKFLOW_TEMPLATES, {
      method: 'POST',
      body: JSON.stringify(template),
    });
  },
};

// Workflows API
export const workflowsAPI = {
  /**
   * Fetch all workflows
   */
  async fetchAll(): Promise<ApiResponse<Flow[]>> {
    return apiRequest<Flow[]>(API_ENDPOINTS.WORKFLOWS);
  },

  /**
   * Fetch a specific workflow by ID
   */
  async fetchById(id: string): Promise<ApiResponse<Flow>> {
    return apiRequest<Flow>(API_ENDPOINTS.WORKFLOW_BY_ID(id));
  },

  /**
   * Create a new workflow
   */
  async create(workflow: Omit<Flow, 'id'>): Promise<ApiResponse<Flow>> {
    return apiRequest<Flow>(API_ENDPOINTS.WORKFLOWS, {
      method: 'POST',
      body: JSON.stringify(workflow),
    });
  },

  /**
   * Update an existing workflow
   */
  async update(id: string, workflow: Partial<Flow>): Promise<ApiResponse<Flow>> {
    return apiRequest<Flow>(API_ENDPOINTS.WORKFLOW_BY_ID(id), {
      method: 'PUT',
      body: JSON.stringify(workflow),
    });
  },

  /**
   * Delete a workflow
   */
  async delete(id: string): Promise<ApiResponse<void>> {
    return apiRequest<void>(API_ENDPOINTS.WORKFLOW_BY_ID(id), {
      method: 'DELETE',
    });
  },
};