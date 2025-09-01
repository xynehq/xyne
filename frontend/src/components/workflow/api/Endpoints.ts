// API endpoints for workflow service
// Using external workflow service URL (matches current WorkflowBuilder usage)
const WORKFLOW_SERVICE_URL = 'https://53b79c6d27eb.ngrok-free.app/v1';

export const API_ENDPOINTS = {
  WORKFLOW_TEMPLATES: `${WORKFLOW_SERVICE_URL}/workflow-template`,
  WORKFLOW_TEMPLATE_BY_ID: (id: string) => `${WORKFLOW_SERVICE_URL}/workflow-template/${id}`,
  WORKFLOW_TEMPLATE_INSTANTIATE: (id: string) => `${WORKFLOW_SERVICE_URL}/workflow-template/${id}/instantiate`,
  WORKFLOWS: `${WORKFLOW_SERVICE_URL}/workflow`,
  WORKFLOW_BY_ID: (id: string) => `${WORKFLOW_SERVICE_URL}/workflow/${id}`,
  WORKFLOW_RUN: (id: string) => `${WORKFLOW_SERVICE_URL}/workflow/${id}/run`,
  WORKFLOW_STEP_COMPLETE: (stepId: string) => `${WORKFLOW_SERVICE_URL}/workflow/step/${stepId}/complete`,
};
