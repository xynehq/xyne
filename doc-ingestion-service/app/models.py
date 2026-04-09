"""Pydantic models for API responses."""

from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List


class HealthResponse(BaseModel):
    """Health check response model."""
    status: str = Field(default="ok", description="Service health status")


class ExtractedImage(BaseModel):
    """Extracted image from document."""
    id: str = Field(..., description="Unique identifier for the image")
    format: str = Field(..., description="Image format (PNG, JPEG, etc.)")
    width: int = Field(..., description="Image width in pixels")
    height: int = Field(..., description="Image height in pixels")
    base64_data: Optional[str] = Field(None, description="Base64-encoded image data")
    page_number: Optional[int] = Field(None, description="Page number where image was found")
    description: Optional[str] = Field(None, description="Optional image description/classification")


class ParseResponse(BaseModel):
    """Document parsing response model."""
    status: str = Field(default="success", description="Operation status")
    document: Dict[str, Any] = Field(..., description="Structured document content")
    filename: Optional[str] = Field(None, description="Original filename")
    file_size: Optional[int] = Field(None, description="File size in bytes")
    extracted_images: Optional[List[ExtractedImage]] = Field(None, description="Images extracted from document")
    ocr_enabled: bool = Field(default=False, description="Whether OCR was used")
    image_extraction_enabled: bool = Field(default=False, description="Whether image extraction was performed")


class ErrorResponse(BaseModel):
    """Error response model."""
    status: str = Field(default="error", description="Error status")
    error: str = Field(..., description="Error message")
    details: Optional[str] = Field(None, description="Additional error details")
