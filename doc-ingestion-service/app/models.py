"""Pydantic models for API responses."""

from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List


class HealthResponse(BaseModel):
    """Health check response model."""
    status: str = Field(default="ok", description="Service health status")


class ParseResponse(BaseModel):
    """Document parsing response model."""
    status: str = Field(default="success", description="Operation status")
    document: Dict[str, Any] = Field(..., description="Structured document content")
    filename: Optional[str] = Field(None, description="Original filename")
    file_size: Optional[int] = Field(None, description="File size in bytes")


class ErrorResponse(BaseModel):
    """Error response model."""
    status: str = Field(default="error", description="Error status")
    error: str = Field(..., description="Error message")
    details: Optional[str] = Field(None, description="Additional error details")
