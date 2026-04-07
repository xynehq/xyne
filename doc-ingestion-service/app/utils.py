"""Utility functions for the ingestion service."""

import logging
from typing import Optional

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB

ALLOWED_EXTENSIONS = {
    '.pdf', '.docx', '.doc', '.pptx', '.ppt', 
    '.xlsx', '.xls', '.odt', '.ods', '.odp', 
    '.txt', '.md', '.html', '.htm', '.rtf'
}


def validate_file_size(file_size: int, max_size: int = MAX_FILE_SIZE) -> tuple[bool, Optional[str]]:
    """
    Validate file size against maximum allowed size.
    
    Args:
        file_size: Size of the file in bytes
        max_size: Maximum allowed size in bytes
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if file_size > max_size:
        max_size_mb = max_size / (1024 * 1024)
        return False, f"File too large. Maximum size allowed: {max_size_mb}MB"
    return True, None


def validate_file_type(filename: str) -> tuple[bool, Optional[str]]:
    """
    Validate file type against allowed extensions.
    
    Args:
        filename: Name of the file
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not filename:
        return False, "Filename is required"
    
    filename_lower = filename.lower()
    has_valid_ext = any(filename_lower.endswith(ext) for ext in ALLOWED_EXTENSIONS)
    
    if not has_valid_ext:
        allowed_list = ', '.join(sorted(ALLOWED_EXTENSIONS))
        return False, f"Unsupported file type. Allowed: {allowed_list}"
    
    return True, None


def setup_logging(level: int = logging.INFO) -> None:
    """Setup logging configuration."""
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
