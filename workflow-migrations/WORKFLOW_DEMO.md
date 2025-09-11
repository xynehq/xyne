# Document Processing Workflow Demo

This demo showcases a complete 3-step workflow for document processing with AI summarization.

## 🔄 Workflow Steps

### 1. **Document Upload Form** (Manual Step)
- **Type**: Form tool with file upload capability
- **User Action**: Upload document (PDF, DOC, DOCX, TXT) and provide metadata
- **Fields**:
  - Document file upload (required)
  - Document title (required)
  - Processing priority (dropdown: low, medium, high, urgent)
  - Additional notes (optional textarea)
- **API**: Form submission via multipart form data

### 2. **AI Summarization** (Automated Step)
- **Type**: Python script tool with agent API integration
- **Process**: 
  - Receives uploaded document metadata from previous step
  - Extracts text content from document
  - Calls AI agent API (Claude) for summarization
  - Returns structured summary with confidence scores
- **Output**: AI-generated summary, confidence score, processing metrics

### 3. **Final Processing** (Automated Step)
- **Type**: Python script tool for report generation
- **Process**:
  - Receives results from both previous steps
  - Generates comprehensive final report
  - Performs any additional business logic
  - Creates audit trail and next actions
- **Output**: Complete workflow report with metrics and recommendations

## 📁 Files Created

### Core Implementation Files
- `api/workflow.ts` - Enhanced workflow API with file upload support
- `db/schema/workflows.ts` - Database schema for workflows
- `db/schema/tools.ts` - Database schema for workflow tools
- `config.ts` - Updated with webhook URL configuration

### Demo Scripts
- `create-document-workflow-template.ts` - Script to create the workflow template
- `test-document-workflow.ts` - Script to test the complete workflow
- `ui-demo.html` - Interactive UI demonstration

### Documentation
- `WORKFLOW_DEMO.md` - This documentation file

## 🚀 How to Use

### 1. Setup Database
Ensure your PostgreSQL database is running and migrations are applied:
```bash
npm run migrate
```

### 2. Create Workflow Template
Run the template creation script:
```bash
# Using bun (if available)
bun run create-document-workflow-template.ts

# Or using node (if compiled)
node create-document-workflow-template.js
```

### 3. Test the Workflow
Run the test script to see the workflow in action:
```bash
bun run test-document-workflow.ts
```

### 4. View UI Demo
Open the HTML file in your browser:
```bash
open ui-demo.html
```

### 5. API Integration
Use the workflow APIs in your application:

#### Create Workflow Execution
```javascript
POST /api/v1/workflow/executions
{
  "workflowTemplateId": "template-uuid",
  "name": "My Document Processing",
  "description": "Processing contract document"
}
```

#### Get Form Definition
```javascript
GET /api/v1/workflow/steps/{stepId}/form
```

#### Submit Form with File
```javascript
POST /api/v1/workflow/steps/submit-form
Content-Type: multipart/form-data

stepId: step-uuid
document_file: [File object]
document_title: "Contract Agreement"
processing_priority: "high"
additional_notes: "Urgent review needed"
```

#### Monitor Workflow Progress
```javascript
GET /api/v1/workflow/executions/{executionId}
```

## 🔧 Technical Implementation

### File Upload Handling
- Files stored on disk in `/downloads/workflow_files/{fileId}/`
- File metadata stored in database result field
- Supported file types: PDF, DOC, DOCX, TXT
- File validation and type checking
- Secure file access via API endpoints

### Form Tool Structure
```typescript
{
  type: "form",
  value: {
    title: "Document Upload Form",
    description: "Upload document for processing",
    fields: [
      {
        id: "document_file",
        label: "Upload Document",
        type: "file",
        required: true,
        fileTypes: ["pdf", "doc", "docx", "txt"]
      }
      // ... other fields
    ]
  }
}
```

### Python Script Integration
- Scripts receive `previous_step_results` parameter
- Access to all previous step outputs
- Can make HTTP requests to external APIs
- Results stored in database for next steps

### Data Flow
```
Form Submission → File Storage → AI Processing → Report Generation
     ↓              ↓              ↓               ↓
   Database      File System    External API    Final Report
```

## 🎯 Key Features

### ✅ File Upload Support
- Multipart form data handling
- File type validation
- Secure file storage
- File serving endpoints

### ✅ AI Integration
- Python scripts can call external APIs
- Previous step results passed automatically
- Structured data exchange between steps
- Error handling and logging

### ✅ Workflow Engine
- Automatic step progression
- Manual and automated step support
- Real-time status tracking
- Result persistence

### ✅ API-First Design
- RESTful API endpoints
- JSON and multipart support
- Authentication middleware
- Comprehensive error handling

## 🔄 Workflow Execution Flow

1. **Workflow Creation**
   ```
   POST /api/v1/workflow/executions
   → Workflow starts automatically
   → First step (form) marked as pending
   ```

2. **Form Step**
   ```
   GET /api/v1/workflow/steps/{stepId}/form
   → Get form definition
   POST /api/v1/workflow/steps/submit-form
   → Submit form with file upload
   → Step marked as completed
   → Next step starts automatically
   ```

3. **AI Processing Step**
   ```
   Python script executes automatically
   → Receives previous step results
   → Processes uploaded document
   → Calls AI agent API
   → Stores results
   → Step marked as completed
   → Next step starts automatically
   ```

4. **Final Processing Step**
   ```
   Python script executes automatically
   → Receives all previous step results
   → Generates final report
   → Performs cleanup/notifications
   → Step marked as completed
   → Workflow marked as completed
   ```

## 📊 Example Data Structures

### Form Submission Result
```json
{
  "formData": {
    "document_file": {
      "fileId": "uuid-123",
      "fileName": "contract.pdf",
      "fileType": "application/pdf",
      "fileSize": 2048576,
      "uploadedAt": "2025-01-02T10:30:00Z"
    },
    "document_title": "Business Contract",
    "processing_priority": "high",
    "additional_notes": "Urgent review needed"
  },
  "submittedAt": "2025-01-02T10:30:00Z",
  "submittedBy": 123
}
```

### AI Summary Result
```json
{
  "summary": "Document analysis results...",
  "confidence_score": 0.94,
  "processing_time": 3.2,
  "agent_response": {
    "status": "success",
    "model": "claude-3-sonnet",
    "tokens_used": 1456
  }
}
```

### Final Report
```json
{
  "workflow_id": "exec-uuid",
  "status": "completed",
  "original_document": { "..." },
  "ai_analysis": { "..." },
  "metrics": {
    "total_processing_time": "< 1 minute",
    "steps_completed": 3,
    "success_rate": "100%"
  },
  "next_actions": ["..."]
}
```

## 🛠 Configuration

### Environment Variables
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/xyne

# File Storage
WORKFLOW_FILES_DIR=/path/to/workflow/files

# AI Integration
OPENAI_API_KEY=your-api-key
# or
AWS_ACCESS_KEY=your-aws-key
AWS_SECRET_KEY=your-aws-secret
```

## 🔍 Monitoring & Debugging

### Workflow Status
- Monitor execution status via API
- Track step completion progress
- View detailed error messages
- Access step execution logs

### File Management
- Files stored with UUID identifiers
- Automatic cleanup policies (configurable)
- File access logs and security
- Storage usage monitoring

### Performance Metrics
- Step execution times
- File upload/download speeds
- AI API response times
- Overall workflow completion rates

This demo provides a complete foundation for building document processing workflows with AI integration, file handling, and automated step execution.