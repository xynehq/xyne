// Base API configuration
const BASE_URL = 'http://localhost:3009/api/v1';

// API endpoints
export const API_ENDPOINTS = {
  WORKFLOW_TEMPLATES: `${BASE_URL}/workflow-templates`,
  WORKFLOWS: `${BASE_URL}/workflows`,
  WORKFLOW_BY_ID: (id: string) => `${BASE_URL}/workflows/${id}`,
};
