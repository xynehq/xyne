"""FastAPI application entrypoint."""

import logging
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional

from app.parser import parse_document
from app.models import HealthResponse, ParseResponse, ErrorResponse
from app.utils import validate_file_size, validate_file_type, setup_logging

setup_logging()
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Document Ingestion Service",
    description="Production-ready document parsing service powered by Docling",
    version="1.0.0"
)

# CORS middleware for TypeScript frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
def health():
    """Health check endpoint."""
    return HealthResponse(status="ok")


@app.post("/parse", response_model=ParseResponse)
async def parse(file: UploadFile = File(...)):
    """
    Parse an uploaded document and return structured JSON.
    
    Supports PDF, DOCX, and other document formats supported by Docling.
    """
    try:
        content = await file.read()
        
        # Validate file type
        is_valid, error_msg = validate_file_type(file.filename)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)
        
        # Validate file size
        is_valid, error_msg = validate_file_size(len(content))
        if not is_valid:
            raise HTTPException(status_code=413, detail=error_msg)
        
        logger.info(f"Processing file: {file.filename} ({len(content)} bytes)")
        
        # Parse document
        # TODO: Add timeout protection for production
        # This is a blocking call - may hang if Docling fails
        parsed = parse_document(content, file.filename)
        
        return ParseResponse(
            status="success",
            document=parsed,
            filename=file.filename,
            file_size=len(content)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error processing file: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
