import { pgEnum } from 'drizzle-orm/pg-core';

// Define all enums for the workflow system
export const workflowStatusEnum = pgEnum('workflow_status_enum', [
  'draft', 
  'active', 
  'completed'
]);

export const stepStatusEnum = pgEnum('step_status_enum', [
  'pending', 
  'in_progress',
  'completed',
  'blocked'
]);

export const stepTypeEnum = pgEnum('step_type_enum', [
  'manual', 
  'automated', 
  'conditional', 
  'parallel', 
  'approval'
]);

export const contentTypeEnum = pgEnum('content_type_enum', [
  'text', 
  'html', 
  'markdown', 
  'form', 
  'api_call', 
  'file_upload'
]);

export const httpMethodEnum = pgEnum('http_method_enum', [
  'GET', 
  'POST', 
  'PUT', 
  'PATCH', 
  'DELETE'
]);

export const integrationStatusEnum = pgEnum('integration_status_enum', [
  'pending', 
  'in_progress', 
  'completed', 
  'failed'
]);

export const serviceInstanceStatusEnum = pgEnum('service_instance_status_enum', [
  'active', 
  'suspended', 
  'configured', 
  'pending'
]);

export const templateWorkflowStatusEnum = pgEnum('template_workflow_status_enum', [
  'active', 
  'draft', 
  'deprecated'
]);

export const serviceConfigStatusEnum = pgEnum('service_config_status_enum', [
  'active', 
  'inactive', 
  'draft'
]);

export const historyActionEnum = pgEnum('history_action_enum', [
  'created',
  'updated', 
  'deleted',
  'completed',
  'started',
  'paused',
  'resumed',
  'assigned',
  'cancelled',
  'failed'
]);

export const toolTypeEnum = pgEnum('tool_type_enum', [
  'python_script',
  'slack', 
  'gmail',
  'agent',
  'delay',
  'merged_node'
]);