"""Docling document parser wrapper."""

import logging
from docling.document_converter import DocumentConverter
from docling.datamodel.document import DocumentStream
from typing import Dict, Any
import io

logger = logging.getLogger(__name__)

converter = DocumentConverter()


def parse_document(file_bytes: bytes, filename: str = "document.pdf") -> Dict[str, Any]:
    """
    Parse a document using Docling and return structured JSON.
    
    Args:
        file_bytes: Raw bytes of the document file
        filename: Name of the document (for Docling stream)
        
    Returns:
        Dict containing structured document representation
    """
    try:
        # Create proper DocumentStream for Docling
        doc_stream = DocumentStream(
            name=filename,
            stream=io.BytesIO(file_bytes)
        )
        
        result = converter.convert(doc_stream)
        
        doc = result.document
        
        logger.info(f"Parsed document successfully: {len(file_bytes)} bytes")
        
        return doc.export_to_dict()
        
    except Exception as e:
        logger.error(f"Failed to parse document: {str(e)}")
        raise
