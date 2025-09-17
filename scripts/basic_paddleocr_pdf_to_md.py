#!/usr/bin/env python3
"""Minimal PDF to Markdown converter backed by PaddleOCR.

The script rasterizes a PDF with pdf2image, runs PaddleOCR on each page, and
emits a lightweight Markdown document. It is intended for quick experiments and
omits the richer layout reconstruction implemented in the main pipeline.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable, List, Sequence

try:  # Lazy import so we can emit a friendly message if missing.
    from pdf2image import convert_from_path  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    convert_from_path = None  # type: ignore

try:
    from paddleocr import PaddleOCR  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    PaddleOCR = None  # type: ignore

try:
    from PIL import Image  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    Image = None  # type: ignore

try:
    import numpy as np
except ModuleNotFoundError:  # pragma: no cover
    np = None  # type: ignore

DEPENDENCY_HINT = """
Missing dependencies. Install the required packages with:

    pip install --upgrade paddleocr pdf2image Pillow numpy

Note: pdf2image requires the Poppler binaries. See https://pypi.org/project/pdf2image/ for installation steps.
"""


def require_dependencies() -> None:
    missing: List[str] = []
    if PaddleOCR is None:
        missing.append("paddleocr")
    if convert_from_path is None:
        missing.append("pdf2image")
    if Image is None:
        missing.append("Pillow")
    if np is None:
        missing.append("numpy")
    if missing:
        sys.stderr.write(DEPENDENCY_HINT)
        sys.stderr.flush()
        sys.exit(2)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a PDF to Markdown using PaddleOCR.")
    parser.add_argument("pdf", type=Path, help="Path to the source PDF file.")
    parser.add_argument(
        "-o",
        "--out",
        dest="out_path",
        type=Path,
        help="Destination Markdown file (defaults to stdout).",
    )
    parser.add_argument("--lang", default="en", help="Language code understood by PaddleOCR (default: en).")
    parser.add_argument("--dpi", type=int, default=200, help="Rasterization DPI passed to pdf2image (default: 200).")
    parser.add_argument(
        "--min-conf",
        type=float,
        default=0.4,
        help="Drop OCR lines whose confidence is lower than this value (default: 0.4).",
    )
    parser.add_argument(
        "--no-page-headings",
        action="store_true",
        help="Do not insert markdown headings for each page.",
    )
    args = parser.parse_args(argv)
    args.pdf = args.pdf.expanduser().resolve()
    if args.out_path:
        args.out_path = args.out_path.expanduser().resolve()
    return args


def iter_ocr_lines(raw: Iterable) -> Iterable:
    """Yield individual OCR line entries while preserving order."""
    if raw is None:
        return
    queue: List = list(raw)
    while queue:
        item = queue.pop(0)
        if item is None:
            continue
        # PaddleOCR usually returns [[line, line, ...]] for a single image.
        if isinstance(item, list) and item and isinstance(item[0], (list, tuple)) and len(item[0]) == 2:
            # Already a list of lines.
            for sub in item:
                yield sub
            continue
        if isinstance(item, list):
            queue = item + queue
            continue
        if isinstance(item, tuple) and len(item) == 2:
            yield item


def lines_from_result(raw_result: Iterable) -> List[tuple]:
    lines: List[tuple] = []
    for entry in iter_ocr_lines(raw_result):
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        box = entry[0]
        text_info = entry[1]
        if not isinstance(text_info, (list, tuple)) or len(text_info) < 2:
            continue
        text = text_info[0]
        score = text_info[1]
        lines.append((box, text, score))
    return lines


def render_markdown(pages: List[Image.Image], ocr: PaddleOCR, min_conf: float, headings: bool) -> str:
    md_lines: List[str] = []
    for page_index, page in enumerate(pages, start=1):
        if headings:
            md_lines.append(f"# Page {page_index}")
            md_lines.append("")
        image_array = np.array(page.convert("RGB"))
        result = ocr.predict(image_array)
        page_text: List[str] = []
        for _box, text, score in lines_from_result(result):
            if not text:
                continue
            try:
                confidence = float(score)
            except (TypeError, ValueError):
                confidence = 0.0
            if confidence < min_conf:
                continue
            cleaned = text.strip()
            if cleaned:
                page_text.append(cleaned)
        if page_text:
            md_lines.extend(page_text)
        else:
            md_lines.append("_No confident text detected._")
        md_lines.append("")
    return "\n".join(md_lines).rstrip() + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    require_dependencies()

    if not args.pdf.exists() or not args.pdf.is_file():
        sys.stderr.write(f"Input PDF not found: {args.pdf}\n")
        sys.stderr.flush()
        return 1

    pages = convert_from_path(str(args.pdf), dpi=args.dpi)
    ocr = PaddleOCR(use_textline_orientation=True, lang=args.lang)
    markdown = render_markdown(pages, ocr, min_conf=args.min_conf, headings=not args.no_page_headings)

    if args.out_path:
        args.out_path.parent.mkdir(parents=True, exist_ok=True)
        args.out_path.write_text(markdown, encoding="utf-8")
    else:
        sys.stdout.write(markdown)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
