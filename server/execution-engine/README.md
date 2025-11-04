# Execution Engine

The Execution Engine is a separate service that handles workflow execution using a BFS (Breadth-First Search) approach with pg-boss for job coordination.

## Overview

- **Service**: Standalone TypeScript service running on port 3020
- **Queue**: Uses pg-boss for job management with custom filtering
- **Execution Model**: BFS with multi-input step coordination
- **Database**: Shares database with main server for workflow state

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Main Server   │    │ Execution Engine│    │   PostgreSQL    │
│   (port 3000)   │    │   (port 3020)   │    │   + pg-boss     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │   Start Execution     │                       │
         ├──────────────────────→│                       │
         │                       │   Queue Steps         │
         │                       ├──────────────────────→│
         │                       │                       │
         │                       │   Workers Pick Jobs   │
         │                       │←──────────────────────│
         │                       │                       │
         │   Status Updates      │                       │
         │←──────────────────────│                       │
```

## Key Components

### 1. Queue Management (`queue/execution-engine-queue.ts`)
- **WorkflowExecutionQueue**: Top-level workflow jobs
- **StepExecutionQueue**: Individual step execution jobs  
- **MergeExecutionQueue**: Multi-input merge steps
- Custom filtering to handle "waiting_inputs" states

### 2. Service Layer (`services/workflowExecutionService.ts`)
- BFS execution logic
- Step completion handling
- Input/output coordination
- Error handling and retries

### 3. Database Layer (`db/workflow-execution.ts`)
- Workflow execution CRUD operations
- Step execution state management
- Input tracking for merge nodes
- Status updates and progress tracking

### 4. API Layer (`api/execution/index.ts`)
- REST endpoints for execution management
- Status monitoring and control
- Admin operations

## BFS Execution Logic

### Multi-Input Step Handling
1. **Create on First Input**: Step execution created when first input arrives
2. **Wait for All Inputs**: Step waits in "waiting_inputs" state
3. **Queue When Ready**: Step queued for execution when all inputs received
4. **Prevent Infinite Loops**: Use singleton keys and conditional queueing

### Job Filtering
```typescript
// Worker filters jobs based on current database state
await boss.work('step-execution', async (job) => {
  const step = await getStepExecution(job.data.step_execution_id)
  
  // Filter out jobs that aren't ready
  if (step.status === 'waiting_inputs') {
    // Reschedule with delay instead of completing
    await boss.send('step-execution', job.data, { 
      delay: '30 seconds',
      singletonKey: `wait-${job.data.step_execution_id}`
    })
    return
  }
  
  if (step.status === 'completed') {
    return // Skip already completed
  }
  
  // Execute ready step
  await executeStep(job.data)
})
```

## Running the Service

### Development
```bash
# Start execution engine only
bun run dev:execution

# Start all services
bun run dev          # Main server
bun run dev:sync     # Sync server  
bun run dev:execution # Execution engine
```

### Production
```bash
bun run execution-engine.ts
```

## Environment Variables

```bash
EXECUTION_ENGINE_PORT=3020
EXECUTION_ENGINE_HOST=localhost
DATABASE_URL=postgres://user:pass@localhost:5432/xyne
```

## API Endpoints

### Public API
- `GET /api/v1/execution/status?execution_id=<id>` - Get execution status
- `POST /api/v1/execution/start` - Start workflow execution
- `POST /api/v1/execution/stop` - Stop workflow execution

### Admin API
- `GET /admin/executions` - List all executions
- `POST /admin/executions/:id/cancel` - Cancel execution

### Health & Metrics
- `GET /health` - Service health check
- `GET /metrics` - Prometheus metrics

## Database Schema

The execution engine uses these tables (to be created):

```sql
-- Workflow execution instances
CREATE TABLE workflow_executions (
  id UUID PRIMARY KEY,
  workflow_template_id UUID REFERENCES workflow_templates(id),
  status VARCHAR NOT NULL,
  inputs JSONB,
  outputs JSONB,
  user_id UUID,
  workspace_id UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Step execution instances  
CREATE TABLE workflow_step_executions (
  id UUID PRIMARY KEY,
  workflow_execution_id UUID REFERENCES workflow_executions(id),
  step_template_id UUID REFERENCES workflow_step_templates(id),
  status VARCHAR NOT NULL,
  required_inputs INTEGER DEFAULT 0,
  received_inputs JSONB[],
  outputs JSONB,
  error TEXT,
  attempt_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Input tracking for merge nodes
CREATE TABLE workflow_input_tracker (
  id UUID PRIMARY KEY,
  step_execution_id UUID REFERENCES workflow_step_executions(id),
  from_step_execution_id UUID REFERENCES workflow_step_executions(id),
  input_data JSONB,
  received_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(step_execution_id, from_step_execution_id)
);
```

## Development Status

✅ **Completed**
- Basic service structure
- Queue configuration  
- API endpoint stubs
- Service layer interfaces
- Database operation stubs

🚧 **TODO** 
- Implement actual BFS execution logic
- Create database schema/migrations
- Implement step execution handlers
- Add comprehensive error handling
- Add metrics and monitoring
- Write tests
- Add deployment configuration

## Deployment

The execution engine will be deployed as a separate container/process alongside the main server and sync server, sharing the same PostgreSQL database and pg-boss queues for coordination.