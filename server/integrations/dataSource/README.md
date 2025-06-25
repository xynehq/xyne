# DataSource File Upload Integration

This module provides a robust and optimized system for uploading and processing various file types for data sources. The system supports multiple file formats, handles file conversion, and stores processed content in Vespa for search and retrieval.

## Features

- **Multi-format Support**: Text, PDF, Excel/CSV, Office documents, and images
- **Intelligent Processing**: Automatic format detection and processing
- **File Conversion**: Converts unsupported formats to PDF when possible
- **Robust Error Handling**: Comprehensive error types and user-friendly messages
- **Resource Management**: Automatic cleanup of temporary files
- **Configurable**: Environment variable-based configuration
- **Type Safety**: Full TypeScript support with comprehensive type definitions

## Supported File Types

### Text Files
- Plain text (`.txt`)
- CSV files (`.csv`)
- Markdown (`.md`)
- HTML (`.html`)
- XML (`.xml`)
- JSON (`.json`)

### Spreadsheets
- Excel XLSX (`.xlsx`)
- Excel XLS (`.xls`)
- CSV files (`.csv`)

### Office Documents
- Word DOCX (`.docx`)
- Word DOC (`.doc`)
- PowerPoint PPTX (`.pptx`)
- PowerPoint PPT (`.ppt`)

### Images
- JPEG (`.jpg`, `.jpeg`)
- PNG (`.png`)
- GIF (`.gif`)
- BMP (`.bmp`)
- TIFF (`.tiff`)
- WebP (`.webp`)

### Other
- PDF (`.pdf`)

## Architecture

The system is organized into several modules:

### Core Files

- **`index.ts`**: Main processing logic and API
- **`config.ts`**: Configuration constants and helper functions
- **`errors.ts`**: Custom error classes and error handling utilities

### Configuration

All configuration is centralized in `config.ts` and can be customized via environment variables:

```typescript
// File size limits
DATASOURCE_MAX_FILE_SIZE_MB=15
DATASOURCE_MAX_CHUNK_SIZE=512

// Processing options
DATASOURCE_CONVERSION_TIMEOUT_MS=30000
DATASOURCE_CLEANUP_RETRY_ATTEMPTS=3

// Validation
DATASOURCE_MIN_CONTENT_LENGTH=10
DATASOURCE_MAX_FILENAME_LENGTH=255

// Directories
DATASOURCE_TEMP_DIR=/path/to/temp/dir

// External tools
LIBREOFFICE_PATH=/path/to/libreoffice
```

## API Usage

### Basic Usage

```typescript
import { handleDataSourceFileUpload } from './index'

const result = await handleDataSourceFileUpload(
  file,                    // File object
  userEmail,              // User email
  dataSourceId,           // Data source ID
  description             // Optional description
)
```

### Response Format

```typescript
interface FileProcessingResult {
  success: boolean
  message: string
  docId: string
  fileName: string
}
```

## Error Handling

The system provides comprehensive error handling with specific error types:

### Error Types

- **`FileValidationError`**: Invalid file format or properties
- **`FileSizeExceededError`**: File too large
- **`UnsupportedFileTypeError`**: File type not supported
- **`FileConversionError`**: Conversion process failed
- **`ContentExtractionError`**: Unable to extract content
- **`InsufficientContentError`**: Content too short
- **`ExternalToolError`**: LibreOffice/ImageMagick issues
- **`TimeoutError`**: Processing took too long
- **`StorageError`**: Database insertion failed

### Error Properties

Each error includes:
- **`code`**: Machine-readable error code
- **`message`**: Technical error message
- **`userMessage`**: User-friendly error message

### Example Error Handling

```typescript
try {
  const result = await handleDataSourceFileUpload(file, email, dsId)
} catch (error) {
  if (isDataSourceError(error)) {
    console.log('Error code:', error.code)
    console.log('User message:', error.userMessage)
  }
}
```

## Processing Flow

1. **Validation**: File size, type, and format validation
2. **Temporary Storage**: Write file to temporary directory
3. **Format Detection**: Determine processing method based on MIME type
4. **Processing**: 
   - Text files: Direct content extraction
   - PDF files: Text extraction
   - Spreadsheets: Cell data extraction and chunking
   - Office/Image files: Convert to PDF then extract text
5. **Chunking**: Split content into searchable chunks
6. **Storage**: Insert processed data into Vespa
7. **Cleanup**: Remove temporary files

## Dependencies

### Required External Tools

For full functionality, install these external tools:

#### LibreOffice (for Office document conversion)
```bash
# macOS
brew install --cask libreoffice

# Ubuntu/Debian
sudo apt-get install libreoffice

# RHEL/CentOS
sudo yum install libreoffice
```

#### ImageMagick (for image conversion)
```bash
# macOS
brew install imagemagick

# Ubuntu/Debian
sudo apt-get install imagemagick

# RHEL/CentOS
sudo yum install ImageMagick
```

### Node.js Dependencies

- `xlsx`: Excel file processing
- `@paralleldrive/cuid2`: ID generation
- `uuid`: UUID generation

## Configuration Examples

### Development Environment

```bash
export DATASOURCE_MAX_FILE_SIZE_MB=5
export DATASOURCE_CONVERSION_TIMEOUT_MS=15000
export DATASOURCE_TEMP_DIR=/tmp/datasource
```

### Production Environment

```bash
export DATASOURCE_MAX_FILE_SIZE_MB=50
export DATASOURCE_CONVERSION_TIMEOUT_MS=60000
export DATASOURCE_TEMP_DIR=/var/tmp/datasource
export LIBREOFFICE_PATH=/usr/bin/soffice
```

## Performance Considerations

- **Memory Usage**: Large files are processed in chunks to minimize memory usage
- **Timeout Handling**: All external tool operations have configurable timeouts
- **Resource Cleanup**: Automatic cleanup of temporary files even on errors
- **Parallel Processing**: Multiple files can be processed concurrently

## Monitoring and Logging

The system provides comprehensive logging:

- **Info Level**: Successful processing events
- **Warn Level**: Non-fatal issues (cleanup failures, etc.)
- **Error Level**: Processing failures with detailed context
- **Debug Level**: Detailed processing steps

### Log Structure

```json
{
  "level": "info",
  "fileName": "document.pdf",
  "docId": "dsf-abc123",
  "userEmail": "user@example.com",
  "mimeType": "application/pdf",
  "message": "DataSource file processed successfully"
}
```

## Security Considerations

- **File Type Validation**: Strict MIME type checking
- **Size Limits**: Configurable file size limits
- **Temporary File Security**: Unique file names and automatic cleanup
- **Input Sanitization**: Content is sanitized during processing

## Troubleshooting

### Common Issues

1. **LibreOffice not found**
   - Ensure LibreOffice is installed
   - Set `LIBREOFFICE_PATH` environment variable

2. **ImageMagick not available**
   - Install ImageMagick
   - Ensure `convert` command is in PATH

3. **File too large**
   - Check `DATASOURCE_MAX_FILE_SIZE_MB` setting
   - Consider increasing the limit

4. **Conversion timeout**
   - Increase `DATASOURCE_CONVERSION_TIMEOUT_MS`
   - Check system resources

### Debug Mode

Enable debug logging to see detailed processing steps:

```typescript
process.env.LOG_LEVEL = 'debug'
```

## Contributing

When adding new file types or features:

1. Update supported types in `config.ts`
2. Add appropriate error handling
3. Include tests for new functionality
4. Update documentation

## License

[Your License Here] 