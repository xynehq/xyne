# Document Ingestion Service

Production-ready document parsing service powered by Docling and FastAPI with Tesseract OCR and image extraction capabilities.

## Features

- **PDF/DOCX Parsing**: Extract structured text from documents
- **Tesseract OCR**: Text extraction from scanned/image-based PDFs
- **Image Extraction**: Extract embedded images (figures, photos, diagrams, charts)
- **Base64 Image Output**: Images returned as base64 in JSON response
- **Multilingual OCR**: Support for multiple languages (English, French, Spanish, German)
- **RESTful API**: FastAPI with automatic OpenAPI docs
- **Docker Support**: Containerized deployment with Tesseract pre-installed
- **CORS Enabled**: Ready for TypeScript frontend integration
- **File Validation**: Size limits (10MB default) and type checking

## Quick Start

### Local Development

1. **Install Tesseract OCR** (system dependency):

   **macOS** (via Homebrew):
   ```bash
   brew install tesseract tesseract-lang
   export TESSDATA_PREFIX=/opt/homebrew/share/tessdata/
   ```

   **Debian/Ubuntu**:
   ```bash
   sudo apt-get install tesseract-ocr tesseract-ocr-eng libtesseract-dev libleptonica-dev pkg-config
   export TESSDATA_PREFIX=$(dpkg -L tesseract-ocr-eng | grep tessdata$)
   ```

2. **Create virtual environment**:
   ```bash
   python3 -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the service**:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

5. **Access API documentation**:
   - Swagger UI: http://localhost:8000/docs
   - ReDoc: http://localhost:8000/redoc

### Docker

```bash
docker build -t doc-ingestion-service .
docker run -p 8000:8000 doc-ingestion-service
```

## API Endpoints

- `GET /health` - Health check
- `POST /parse` - Upload and parse a document

## Usage Examples

### Basic Document Parsing

```bash
curl -X POST "http://localhost:8000/parse" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@document.pdf"
```

### Response Format

```json
{
  "status": "success",
  "document": { ... },
  "filename": "document.pdf",
  "file_size": 1234567,
  "extracted_images": [
    {
      "id": "abc123_img_1",
      "format": "PNG",
      "width": 800,
      "height": 600,
      "base64_data": "data:image/png;base64,iVBORw0KGgo...",
      "page_number": 1,
      "description": null
    }
  ],
  "ocr_enabled": true,
  "image_extraction_enabled": true
}
```

### Integration with TypeScript

```typescript
const formData = new FormData();
formData.append("file", file);

const res = await fetch("http://localhost:8000/parse", {
  method: "POST",
  body: formData,
});

const data = await res.json();
console.log(data.document); // Structured document content
console.log(data.extracted_images); // Array of extracted images with base64 data

// Display an extracted image
if (data.extracted_images && data.extracted_images.length > 0) {
  const img = document.createElement('img');
  img.src = data.extracted_images[0].base64_data;
  document.body.appendChild(img);
}
```

## Configuration

Environment variables for customization:

| Variable | Default | Description |
|----------|---------|-------------|
| `OCR_ENABLED` | `true` | Enable Tesseract OCR for scanned documents |
| `IMAGE_EXTRACTION_ENABLED` | `true` | Enable extraction of embedded images |
| `IMAGE_SCALE` | `2.0` | Resolution scale for extracted images (higher = better quality) |
| `EXTRACTED_IMAGES_DIR` | `/tmp/extracted-images` | Directory for temporary image storage |
| `MAX_FILE_SIZE` | `10485760` | Maximum upload size in bytes (default: 10MB) |
| `LOG_LEVEL` | `INFO` | Logging level (DEBUG, INFO, WARNING, ERROR) |

### Example: Disable OCR and only extract text

```bash
export OCR_ENABLED=false
export IMAGE_EXTRACTION_ENABLED=false
uvicorn app.main:app --reload
```

## Architecture

```
PDF/DOCX → Docling Parser → Tesseract OCR → Image Extraction → Structured JSON + Base64 Images
```

### OCR Process
1. Document uploaded via `/parse` endpoint
2. Docling pipeline processes document
3. Tesseract OCR extracts text from image-based content
4. Configured languages applied automatically
5. Structured text returned in JSON

### Image Extraction Process
1. Pipeline detects `PictureItem` elements
2. Images cropped from rendered pages at specified scale
3. Images converted to base64 format
4. Metadata (dimensions, page number) captured
5. Returned as array in response

## Supported OCR Languages

Tesseract supports 100+ languages. Common codes:
- `eng` - English
- `fra` - French
- `deu` - German
- `spa` - Spanish
- `ita` - Italian
- `por` - Portuguese
- `rus` - Russian
- `chi_sim` - Chinese (Simplified)
- `jpn` - Japanese
- `ara` - Arabic

Install additional language packs as needed:
```bash
# Debian/Ubuntu
sudo apt-get install tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-spa

# macOS
brew install tesseract-lang
```

## Development

### Testing

Use the provided test script:
```bash
python test_parse.py /path/to/document.pdf
```

### Project Structure

```
doc-ingestion-service/
├── app/
│   ├── main.py          # FastAPI application
│   ├── parser.py        # Docling integration with OCR/images
│   ├── models.py        # Pydantic response models
│   └── utils.py         # Validation and configuration
├── Dockerfile           # Container configuration
├── requirements.txt     # Python dependencies
├── test_parse.py       # Test script
└── README.md           # This file
```

## Performance Considerations

- **OCR Impact**: Enabling OCR increases processing time significantly (2-5x slower)
- **Image Extraction**: Large images or many images increase response size
- **Memory Usage**: Base64 encoding increases memory usage (~33% overhead)
- **First Request**: Docling downloads models on first run (subsequent requests are faster)

## License

MIT
