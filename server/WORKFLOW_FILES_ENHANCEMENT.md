# Enhanced Workflow File Upload System

## Overview

The workflow file upload system has been enhanced to use the Knowledge Base approach for better file management, content extraction, and accessibility in AI and email nodes.

## What's Changed

### Before
- Files stored in `/tmp/workflow_uploads/{executionId}/{stepId}/`
- Basic file metadata only
- Manual file reading and processing in each node
- No searchability
- Limited content extraction

### After
- Files stored in organized structure with Knowledge Base integration
- Full content extraction and chunking using `FileProcessorService`
- Automatic Vespa indexing for searchability
- Rich metadata and processing information
- Content accessible via enhanced APIs in AI and email nodes

## Key Features

### 1. Enhanced File Processing
- **Automatic Content Extraction**: PDFs, DOCX, PPTX, images, text files
- **Document Chunking**: 512-byte chunks for optimal processing
- **Vector Embeddings**: 384-dimensional embeddings for semantic search
- **Image Processing**: OCR-ready preprocessing and metadata extraction

### 2. Vespa Integration
- Files stored in `kb_items` schema
- Full-text search capabilities
- Vector similarity search
- Hybrid search (BM25 + Vector)
- Metadata filtering and querying

### 3. Enhanced APIs
- `getWorkflowFilesAsContext()`: Get all files with content for AI processing
- `getWorkflowExecutionFiles()`: List all files in a workflow execution
- `searchWorkflowFiles()`: Search files by content across workflows
- `getWorkflowFileContent()`: Get specific file content by Vespa ID

## Usage Examples

### Form Upload (Enhanced)
When users upload files through forms, they are now:
1. Processed using `FileProcessorService` for content extraction
2. Stored with organized metadata
3. Indexed in Vespa for searchability
4. Made available to subsequent workflow nodes

### AI Agent Node (Enhanced)
```typescript
// Before: Manual file reading with limited format support
// After: Automatic access to all processed file content

// The AI agent now automatically receives:
- Text content from all uploaded files
- Extracted text from PDFs, DOCX, PPTX
- Image metadata and processing status
- File metadata and context
```

### Email Node (Enhanced)
```typescript
// New configuration options:
{
  "include_files": true,           // Include file list in email
  "include_file_content": true,    // Include file content previews
  "to_email": ["recipient@example.com"],
  "subject": "Workflow Results with Files"
}

// Email automatically includes:
- List of processed files
- File metadata (size, type, upload time)
- Content previews (truncated for readability)
- File processing status
```

## Configuration

### Enhanced File Upload Configuration
```typescript
interface EnhancedWorkflowFileUpload {
  vespaDocId: string      // Unique Vespa document ID
  checksum: string        // File integrity verification
  processedChunks: number // Number of text chunks extracted
  imageChunks: number     // Number of image chunks processed
  isSearchable: boolean   // Whether content was successfully extracted
  contentExtracted: boolean // Processing success status
  // ... plus all original WorkflowFileUpload fields
}
```

### Email Node Configuration
```typescript
{
  "to_email": ["user@example.com"],
  "subject": "Workflow Results",
  "content_type": "html",           // or "text"
  "include_files": true,            // NEW: Include file information
  "include_file_content": true,     // NEW: Include content previews
  "content_path": "step1.aiOutput"  // Optional: specific content path
}
```

## File Storage Structure

### Physical Storage
```
storage/workflow_files/
├── {executionId}/
│   ├── {stepId}/
│   │   ├── {year}/
│   │   │   ├── {month}/
│   │   │   │   └── {timestamp}_{random}_{filename}
```

### Vespa Document Structure
```typescript
{
  docId: "workflow_file_uuid",
  clId: "executionId",              // Collection = Execution
  itemId: "executionId_stepId_timestamp",
  fileName: "Workflow/execution/step/file.pdf",
  app: "KnowledgeBase",
  entity: "file",
  chunks: ["chunk1", "chunk2", ...], // Extracted text chunks
  image_chunks: ["img1", "img2", ...], // Processed images
  metadata: {
    workflowExecutionId: "...",
    workflowStepId: "...",
    originalFileName: "document.pdf",
    isWorkflowFile: true,
    chunksCount: 15,
    imageChunksCount: 3,
    // ... additional metadata
  }
}
```

## Search Capabilities

### Search by Content
```typescript
// Search across all workflow files
const results = await searchWorkflowFiles("contract terms", null, 10)

// Search within specific execution
const results = await searchWorkflowFiles("budget analysis", executionId, 5)
```

### Get Files by Execution
```typescript
// Get all files from a workflow execution
const files = await getWorkflowExecutionFiles(executionId)

// Get files from specific step
const stepFiles = await getWorkflowStepFiles(executionId, stepId)
```

## Migration Notes

### Backward Compatibility
- Existing workflows continue to work
- Original file upload functions still available
- Enhanced functions are opt-in upgrades

### Performance Considerations
- File processing adds ~2-5 seconds per file
- Vespa indexing is asynchronous
- Content extraction scales with file size and complexity
- Vector embeddings generation requires compute resources

## Error Handling

### File Processing Failures
- System gracefully handles processing errors
- Failed files still stored with basic metadata
- Error details logged for debugging
- Workflow execution continues

### Vespa Integration Failures
- Files stored locally even if Vespa fails
- Search functionality degraded but not broken
- Retry mechanisms for transient failures

## Future Enhancements

### Planned Features
1. **OCR Integration**: Full text extraction from images
2. **Advanced Search**: Semantic search across file content
3. **File Versioning**: Track file modifications and history
4. **Batch Processing**: Optimize multiple file uploads
5. **Content Summarization**: AI-powered file summaries

### API Extensions
1. **File Download APIs**: Direct file access for workflows
2. **Content Streaming**: Large file content streaming
3. **Search Filters**: Advanced filtering by file type, date, etc.
4. **Analytics**: File usage and processing statistics

## Development Notes

### Key Files Modified
- `/api/workflowFileHandlerEnhanced.ts` - New enhanced file handler
- `/api/workflow.ts` - Integration with AI and email nodes
- `/services/fileProcessor.ts` - Content extraction service
- `/search/vespa.ts` - Vespa integration for indexing

### Testing
- Upload various file types through form nodes
- Verify content extraction in AI agent outputs
- Check email node file inclusion
- Test search functionality across executions

This enhanced system provides a much more powerful and flexible file handling capability for workflows while maintaining backward compatibility and graceful error handling.