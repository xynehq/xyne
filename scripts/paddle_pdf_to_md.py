#!/usr/bin/env python3
"""Compatibility wrapper for paddleocr_pdf_to_md.py.

Allows invoking the tool as `paddle_pdf_to_md.py` if you’re used to that name.
"""

from __future__ import annotations

from typing import Sequence, Optional

try:
    # Local import from the same directory
    from paddleocr_pdf_to_md import main as _main  # type: ignore
except Exception as e:  # pragma: no cover
    import sys
    sys.stderr.write(f"Failed to import paddleocr_pdf_to_md: {e}\n")
    sys.exit(2)


def main(argv: Optional[Sequence[str]] = None) -> int:  # pragma: no cover
    return _main(argv)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

