# Complete Document Processing Workflow System

A comprehensive document processing workflow system with React UI, file uploads, AI integration, and automated step execution.

## 🎯 System Overview

This system provides a complete workflow automation platform for document processing with:

1. **Document Upload Form** - Interactive UI for file uploads with metadata
2. **AI Summarization** - Automated document analysis using AI agents  
3. **Final Processing** - Python script execution with report generation
4. **Real-time UI** - React interface with live workflow monitoring

## 📁 Complete File Structure

```
xyne/server/
├── api/
│   └── workflow.ts                    # Enhanced workflow API with file upload support
├── db/
│   ├── schema/
│   │   ├── workflows.ts               # Workflow database schema
│   │   └── tools.ts                   # Tool database schema
│   ├── workflow.ts                    # Workflow database operations
│   └── workflowTool.ts               # Tool database operations
├── workflow-ui/                      # Complete React UI
│   ├── src/
│   │   ├── components/
│   │   │   ├── WorkflowTemplateCard.tsx
│   │   │   ├── FormField.tsx
│   │   │   └── WorkflowExecution.tsx
│   │   ├── hooks/
│   │   │   └── useWorkflow.ts
│   │   ├── types/
│   │   │   └── workflow.ts
│   │   ├── utils/
│   │   │   └── api.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── README.md
├── create-document-workflow-template.ts  # Template creation script
├── test-document-workflow.ts             # Workflow testing script
├── build-ui.js                          # UI build script
├── ui-demo.html                          # Static demo page
├── config.ts                             # Updated with webhook config
├── server.ts                             # Updated with UI routes
├── WORKFLOW_DEMO.md                      # Technical documentation
└── WORKFLOW_COMPLETE_GUIDE.md            # This comprehensive guide
```

## 🚀 Quick Start Guide

### 1. Setup and Installation

```bash
# Navigate to server directory
cd /Users/yash.daga/repo/xyne/server

# Install server dependencies (if needed)
npm install

# Setup database migrations
npm run migrate
```

### 2. Create Workflow Template

```bash
# Create the document processing workflow template
node create-document-workflow-template.ts
```

### 3. Build and Start UI

```bash
# Build the React UI
node build-ui.js

# Start the server (if not already running)
npm run dev
```

### 4. Access the System

- **Main UI**: http://localhost:3000/workflow-ui
- **Static Demo**: Open `ui-demo.html` in browser
- **API Base**: http://localhost:3000/api/v1

## 🔧 System Components

### Backend Components

#### 1. Workflow API (`api/workflow.ts`)
- **Templates**: CRUD operations for workflow templates
- **Executions**: Create and manage workflow runs
- **Steps**: Handle manual and automated step execution
- **Forms**: Dynamic form generation and submission
- **Files**: Secure file upload and serving

#### 2. Database Schema
- **Workflow Templates**: Reusable workflow definitions
- **Workflow Executions**: Individual workflow runs
- **Step Templates/Executions**: Individual workflow steps
- **Tools**: Configurable tools (forms, scripts, AI agents)
- **Tool Executions**: Track tool usage and results

#### 3. File Handling
- **Storage**: Files stored on disk with UUID identifiers
- **Metadata**: File info stored in database results
- **Security**: Authenticated file access endpoints
- **Validation**: File type and size restrictions

### Frontend Components

#### 1. React UI (`workflow-ui/`)
- **Template Browser**: View and start workflow templates
- **Execution Monitor**: Real-time workflow progress tracking
- **Form Interface**: Dynamic form rendering with file uploads
- **Step Visualization**: Visual progress indicators

#### 2. Key React Components
- **WorkflowTemplateCard**: Template selection interface
- **WorkflowExecution**: Main execution monitoring page
- **FormField**: Dynamic form field components with file upload
- **Custom Hooks**: API integration and state management

## 📋 Workflow Definition

### Template Structure
```json
{
  "name": "Document Processing Workflow",
  "description": "Upload document, summarize with AI, and process with Python script",
  "version": "1.0.0",
  "steps": [
    {
      "name": "Document Upload Form",
      "type": "manual",
      "tool": "form",
      "order": 1
    },
    {
      "name": "AI Summarization", 
      "type": "automated",
      "tool": "python_script",
      "order": 2
    },
    {
      "name": "Final Processing",
      "type": "automated", 
      "tool": "python_script",
      "order": 3
    }
  ]
}
```

### Step 1: Document Upload Form
```json
{
  "type": "form",
  "value": {
    "title": "Document Upload Form",
    "fields": [
      {
        "id": "document_file",
        "label": "Upload Document", 
        "type": "file",
        "required": true,
        "fileTypes": ["pdf", "doc", "docx", "txt"]
      },
      {
        "id": "document_title",
        "label": "Document Title",
        "type": "text",
        "required": true
      },
      {
        "id": "processing_priority",
        "label": "Processing Priority",
        "type": "dropdown", 
        "options": ["low", "medium", "high", "urgent"]
      }
    ]
  }
}
```

### Step 2: AI Summarization Script
```python
import requests
import json

def summarize_document(previous_step_results):
    # Get document from previous form step
    form_results = previous_step_results.get('Document Upload Form', {})
    form_data = form_results.get('toolResults', [{}])[0].get('result', {}).get('formData', {})
    
    document_info = form_data.get('document_file', {})
    document_title = form_data.get('document_title', 'Untitled')
    
    # In real implementation:
    # 1. Read file content using document_info['fileId']
    # 2. Extract text from PDF/DOC/TXT
    # 3. Call AI API (Claude, GPT, etc.)
    
    # Mock AI response
    summary_result = {
        "summary": f"AI analysis of {document_title}...",
        "confidence_score": 0.94,
        "processing_time": 3.2,
        "agent_response": {
            "status": "success",
            "model": "claude-3-sonnet",
            "tokens_used": 1456
        }
    }
    
    return summary_result
```

### Step 3: Final Processing Script
```python
import json
import datetime

def process_summary_results(previous_step_results):
    # Get results from both previous steps
    form_results = previous_step_results.get('Document Upload Form', {})
    summary_results = previous_step_results.get('AI Summarization', {})
    
    # Generate final report
    final_report = {
        "workflow_id": "document-processing",
        "processed_at": datetime.datetime.now().isoformat(),
        "status": "completed",
        "original_document": form_results,
        "ai_analysis": summary_results,
        "next_actions": [
            "Document archived in system",
            "Summary available for review", 
            "Stakeholders notified"
        ]
    }
    
    return final_report
```

## 🌐 API Endpoints

### Workflow Templates
```http
GET    /api/v1/workflow/templates           # List all templates
GET    /api/v1/workflow/templates/{id}      # Get specific template
POST   /api/v1/workflow/templates           # Create new template
PUT    /api/v1/workflow/templates/{id}      # Update template
```

### Workflow Executions
```http
POST   /api/v1/workflow/executions          # Create execution (auto-starts)
GET    /api/v1/workflow/executions          # List executions  
GET    /api/v1/workflow/executions/{id}     # Get execution details
```

### Workflow Steps
```http
GET    /api/v1/workflow/steps/{id}/form     # Get form definition
POST   /api/v1/workflow/steps/submit-form   # Submit form (multipart or JSON)
POST   /api/v1/workflow/steps/{id}/complete # Complete manual step
```

### Tools
```http
POST   /api/v1/workflow/tools               # Create tool
GET    /api/v1/workflow/tools               # List tools
```

### Files
```http
GET    /api/v1/workflow/files/{fileId}      # Download/view file
```

## 🔄 Execution Flow

### 1. Workflow Creation
```javascript
// User starts workflow from UI
POST /api/v1/workflow/executions
{
  "workflowTemplateId": "template-uuid",
  "name": "Contract Processing",
  "description": "Process legal contract"
}

// Response includes execution ID and auto-started workflow
{
  "success": true,
  "message": "Workflow created and started", 
  "data": {
    "externalId": "exec-uuid",
    "status": "active"
  }
}
```

### 2. Form Step Execution
```javascript
// Get form definition
GET /api/v1/workflow/steps/step-1-uuid/form

// Submit form with file upload
POST /api/v1/workflow/steps/submit-form
Content-Type: multipart/form-data

stepId: step-1-uuid
document_file: [File object]
document_title: "Legal Contract"
processing_priority: "high"
```

### 3. Automated Step Execution
```python
# AI Summarization (executed automatically)
def executeAutomatedStep(stepExecution):
    # Get tool for this step
    tool = getWorkflowToolById(stepExecution.toolIds)
    
    # Get previous step results
    previousResults = getPreviousStepResults(stepExecution.workflowExecutionId)
    
    # Execute Python script with context
    result = executeWorkflowTool(tool, stepExecution.externalId, previousResults)
    
    # Store results and continue to next step
    markWorkflowToolExecutionCompleted(result)
    continueWorkflowExecution(stepExecution.workflowExecutionId)
```

### 4. Real-time Monitoring
```javascript
// UI polls for updates every 2 seconds
const { execution } = useWorkflowPolling(executionId, 2000);

// Shows live progress:
// ✅ Document Upload Form - Completed
// 🔄 AI Summarization - Running  
// ⏳ Final Processing - Pending
```

## 💾 Data Storage

### File Storage Strategy
```
/downloads/workflow_files/
├── {uuid-1}/
│   └── 0.pdf                    # Original file
├── {uuid-2}/  
│   └── 0.docx                   # Original file
└── {uuid-3}/
    └── 0.txt                    # Original file
```

### Database Storage
```sql
-- Workflow execution with metadata
workflow_executions: {
  external_id: "exec-uuid",
  name: "Contract Processing",
  status: "active",
  metadata: {...}
}

-- Step execution tracking
workflow_step_executions: {
  external_id: "step-uuid", 
  name: "Document Upload Form",
  status: "done",
  completed_at: "2025-01-02T10:30:00Z"
}

-- Tool execution results
workflow_tool_executions: {
  step_id: "step-uuid",
  tool_id: "tool-uuid",
  status: "completed",
  result: {
    "formData": {
      "document_file": {
        "fileId": "file-uuid",
        "fileName": "contract.pdf",
        "fileSize": 2048576
      }
    }
  }
}
```

## 🎨 UI Features

### Template Browser
- Grid layout of available workflow templates
- Status indicators (active, draft, etc.)
- Template descriptions and version info
- One-click workflow starting

### Execution Monitor
- Real-time step progress visualization
- Interactive forms for manual steps
- File upload with drag & drop
- Progress indicators and status updates

### Form Interface
- Dynamic form generation from tool definitions
- File upload with type validation
- Field validation and error handling
- Responsive design for all devices

## 🔧 Configuration

### Environment Variables
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/xyne

# File Storage
WORKFLOW_FILES_DIR=/path/to/workflow/files

# AI Integration  
OPENAI_API_KEY=your-openai-key
# or
AWS_ACCESS_KEY=your-aws-key
AWS_SECRET_KEY=your-aws-secret

# Webhook (optional)
WORKFLOW_WEBHOOK_URL=https://your-webhook-endpoint.com
```

### Server Configuration
```typescript
// config.ts additions
export default {
  // ... existing config
  webhookUrl: process.env.WORKFLOW_WEBHOOK_URL || "",
  // File upload limits
  MAX_FILE_SIZE: 40 * 1024 * 1024, // 40MB
}
```

## 🚀 Deployment

### Development
```bash
# Start server
npm run dev

# Build UI (in separate terminal)
node build-ui.js

# Access at:
# UI: http://localhost:3000/workflow-ui
# API: http://localhost:3000/api/v1
```

### Production
```bash
# Build everything
npm run build
node build-ui.js

# Deploy workflow-ui-dist/ folder with main server
# Configure reverse proxy for /workflow-ui routes
```

## 🔍 Testing

### Manual Testing
```bash
# Test workflow creation
node test-document-workflow.ts

# Test template creation  
node create-document-workflow-template.ts
```

### UI Testing
1. Open http://localhost:3000/workflow-ui
2. Click "Start Workflow" on Document Processing template
3. Fill out form and upload test file
4. Watch automated steps execute
5. View final results

### API Testing
```bash
# Test template creation
curl -X POST http://localhost:3000/api/v1/workflow/templates \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Workflow", "description": "Test"}'

# Test execution creation
curl -X POST http://localhost:3000/api/v1/workflow/executions \
  -H "Content-Type: application/json" \
  -d '{"workflowTemplateId": "template-id", "name": "Test Run"}'
```

## 🛠 Troubleshooting

### Common Issues

1. **UI Not Loading**
   - Run `node build-ui.js` to build UI
   - Check server is running on port 3000
   - Verify workflow-ui-dist/ folder exists

2. **File Upload Failing**
   - Check file type is in allowed list
   - Verify file size under limit (40MB)
   - Ensure WORKFLOW_FILES_DIR is writable

3. **Workflow Not Starting**
   - Verify template exists and is "active" status
   - Check database migrations are applied
   - Review server logs for errors

4. **API Calls Failing**
   - Verify authentication is working
   - Check CORS settings if needed
   - Review network tab in browser dev tools

### Debug Mode
```bash
# Enable debug logging
XYNE_DEBUG_MODE=true npm run dev

# Check file permissions
ls -la downloads/workflow_files/

# Verify database connectivity
psql -d xyne -c "SELECT * FROM workflow_templates LIMIT 1;"
```

## 📊 Monitoring

### Workflow Metrics
- Execution success/failure rates
- Average processing times per step
- File upload success rates
- User engagement metrics

### System Health
- Database connection status
- File system disk usage
- API response times
- Error rates and types

## 🔐 Security

### Authentication
- All UI routes protected by AuthRedirect middleware
- API endpoints require valid JWT tokens
- File access controlled via authenticated endpoints

### File Security
- Files stored with UUID identifiers
- No direct file system access from web
- File type validation on upload
- Configurable file size limits

### Data Protection
- Sensitive data not logged
- Secure file cleanup policies
- Audit trail for all workflow actions

## 🎯 Next Steps

### Potential Enhancements

1. **Advanced AI Integration**
   - Support for multiple AI providers
   - Custom prompt templates
   - Model selection per workflow

2. **Enhanced File Processing**
   - OCR for scanned documents
   - Document format conversion
   - Batch file processing

3. **Workflow Builder**
   - Visual workflow designer
   - Drag & drop step creation
   - Conditional step logic

4. **Notifications**
   - Email/Slack notifications
   - Webhook integrations
   - Custom notification rules

5. **Analytics Dashboard**
   - Workflow performance metrics
   - User activity tracking
   - System usage reports

This comprehensive system provides a solid foundation for document processing workflows with room for extensive customization and enhancement.