# Document Ingestion Service

Production-ready document parsing service powered by Docling and FastAPI.

## Features

- Parse PDF, DOCX, and other document formats
- Structured JSON output
- RESTful API with FastAPI
- Docker support
- CORS enabled for frontend integration
- File size validation (10MB default)

## Quick Start

### Local Development

1. Create virtual environment:
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Run the service:
```bash
uvicorn app.main:app --reload --port 8000
```

4. Access API documentation:
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

## Usage Example

```bash
curl -X POST "http://localhost:8000/parse" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@document.pdf"
```

## Integration with TypeScript

```typescript
const formData = new FormData();
formData.append("file", file);

const res = await fetch("http://localhost:8000/parse", {
  method: "POST",
  body: formData,
});

const data = await res.json();
console.log(data.document); // Structured document content
```

## Architecture

```
PDF/DOCX → Docling Parser → Structured JSON → TypeScript Frontend
```

## Configuration

Environment variables:
- `MAX_FILE_SIZE` - Maximum upload size in bytes (default: 10MB)
- `LOG_LEVEL` - Logging level (default: INFO)

## License

MIT
