import { Flow, TemplateFlow } from "../Types"

// API response types
interface ApiResponse<T> {
  data?: T
  error?: string
  status: number
}

// Base URL for workflow service
const WORKFLOW_BASE_URL =
  `${import.meta.env.VITE_API_BASE_URL}/v1` || "http://localhost:3000/v1"

async function apiRequest<T>(
  url: string,
  options?: RequestInit,
): Promise<ApiResponse<T>> {
  try {
    const init: RequestInit = {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(options?.headers ?? {}),
      },
    }
    const response = await fetch(url, init)

    const contentType = response.headers.get("content-type") ?? ""
    let data: any = undefined
    if (response.status !== 204 && response.status !== 205) {
      if (contentType.includes("application/json")) {
        data = await response.json()
      } else {
        const text = await response.text()
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
    }

    if (!response.ok) {
      return {
        error:
          (data && (data.message || data.error)) ||
          `HTTP ${response.status}: ${response.statusText}`,
        status: response.status,
      }
    }

    return { data: data as T, status: response.status }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Network error",
      status: 0,
    }
  }
}

// Workflow Templates API
export const workflowTemplatesAPI = {
  /**
   * Fetch a specific workflow template by ID
   */
  async fetchById(id: string): Promise<ApiResponse<TemplateFlow>> {
    return apiRequest<TemplateFlow>(
      `${WORKFLOW_BASE_URL}/workflow-template/${id}`,
    )
  },

  /**
   * Instantiate a workflow template
   */
  async instantiate(
    id: string,
    options: { name: string; metadata?: any },
  ): Promise<ApiResponse<{ workflowId: string; rootStepId: string }>> {
    return apiRequest<{ workflowId: string; rootStepId: string }>(
      `${WORKFLOW_BASE_URL}/workflow-template/${id}/instantiate`,
      {
        method: "POST",
        body: JSON.stringify(options),
      },
    )
  },
}

// Workflows API
export const workflowsAPI = {
  /**
   * Fetch a specific workflow by ID
   */
  async fetchById(id: string): Promise<ApiResponse<Flow>> {
    return apiRequest<Flow>(`${WORKFLOW_BASE_URL}/workflow/${id}`)
  },

  /**
   * Run a workflow
   */
  async run(id: string): Promise<ApiResponse<any>> {
    return apiRequest<any>(`${WORKFLOW_BASE_URL}/workflow/${id}/run`, {
      method: "POST",
    })
  },

  /**
   * Complete a workflow step
   */
  async completeStep(stepId: string): Promise<ApiResponse<any>> {
    return apiRequest<any>(
      `${WORKFLOW_BASE_URL}/workflow/step/${stepId}/complete`,
      {
        method: "POST",
      },
    )
  },

  /**
   * Poll for workflow process completion status
   */
  async pollProcessStatus(): Promise<
    ApiResponse<{ status: string; message?: string }>
  > {
    return apiRequest<{ status: string; message?: string }>(
      `${WORKFLOW_BASE_URL}/status`,
      {
        method: "GET",
      },
    )
  },

  /**
   * Start polling for process completion with callback
   * @param onComplete - Callback function called when process is completed
   * @param onError - Callback function called on polling error
   * @param interval - Polling interval in milliseconds (default: 2000)
   * @returns Function to stop polling
   */
  startPolling(
    onComplete: () => void,
    onError?: (error: string) => void,
    interval: number = 2000,
  ): () => void {
    const pollingInterval = setInterval(async () => {
      try {
        const response = await this.pollProcessStatus()

        if (response.data) {
          if (
            response.data.status === "completed" ||
            response.data.message === "process completed"
          ) {
            clearInterval(pollingInterval)
            onComplete()
          }
        }
      } catch (error) {
        console.error("Polling error:", error)
        if (onError) {
          onError(error instanceof Error ? error.message : "Polling error")
        }
      }
    }, interval)

    // Return function to stop polling
    return () => {
      clearInterval(pollingInterval)
    }
  },

  /**
   * Upload a file to the workflow service
   */
  async uploadFile(
    file: File,
    uploadUrl: string = `${WORKFLOW_BASE_URL}/upload`,
  ): Promise<ApiResponse<any>> {
    try {
      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch(uploadUrl, {
        method: "POST",
        body: formData,
      })

      const data = await response.json()

      if (!response.ok) {
        return {
          error:
            data.message ||
            `Upload failed (${response.status}): ${response.statusText}`,
          status: response.status,
        }
      }

      return {
        data,
        status: response.status,
      }
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Upload failed: Please check your connection and try again.",
        status: 0,
      }
    }
  },
}
