"""Docling document parser with Tesseract OCR and image extraction."""

import logging
import io
from typing import Dict, Any

from docling.document_converter import DocumentConverter
from docling.datamodel.document import DocumentStream
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    PdfPipelineOptions,
    TesseractCliOcrOptions,
)
from docling.document_converter import PdfFormatOption
from docling_core.types.doc import PictureItem

from app.utils import (
    OCR_ENABLED,
    IMAGE_EXTRACTION_ENABLED,
    IMAGE_SCALE,
)

logger = logging.getLogger(__name__)


def create_document_converter() -> DocumentConverter:
    """Create a DocumentConverter with OCR and image extraction configured."""
    pipeline_options = PdfPipelineOptions()
    
    # Configure OCR
    if OCR_ENABLED:
        pipeline_options.do_ocr = True
        pipeline_options.ocr_options = TesseractCliOcrOptions(
            lang=["auto"],
        )
    else:
        pipeline_options.do_ocr = False
        logger.info("OCR disabled")
    
    # Configure image extraction
    if IMAGE_EXTRACTION_ENABLED:
        pipeline_options.generate_picture_images = True
        pipeline_options.images_scale = IMAGE_SCALE
        logger.info(f"Image extraction enabled with scale: {IMAGE_SCALE}")
    else:
        pipeline_options.generate_picture_images = False
        logger.info("Image extraction disabled")
    
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    )
    
    return converter


# Initialize converter with configuration
converter = create_document_converter()


def parse_document(file_bytes: bytes, filename: str = "document.pdf") -> Dict[str, Any]:
    """
    Parse a document using Docling with OCR and image extraction.
    
    Args:
        file_bytes: Raw bytes of the document file
        filename: Name of the document (for Docling stream)
        
    Returns:
        Dict containing structured document representation and metadata
    """
    try:
        # Create proper DocumentStream for Docling
        doc_stream = DocumentStream(
            name=filename,
            stream=io.BytesIO(file_bytes)
        )
        
        logger.info(f"Parsing document: {filename} ({len(file_bytes)} bytes)")
        result = converter.convert(doc_stream)
        
        doc = result.document
        
        logger.info(f"Parsed document successfully: {len(file_bytes)} bytes")
        
        return doc.export_to_dict()
        
    except Exception as e:
        logger.error(f"Failed to parse document: {str(e)}")
        raise
