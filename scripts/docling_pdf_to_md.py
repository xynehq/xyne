#!/usr/bin/env python3
"""
Docling-based PDF to Markdown and layout extractor.

Usage:
  python scripts/docling_pdf_to_md.py input.pdf \
      --out-md out.md \
      --out-layout layout.json

This script attempts to use the Docling Python API to:
  - Parse the PDF and export Markdown
  - Export a simple layout analysis JSON (pages, blocks, coordinates if available)

If the Docling library is not installed, the script prints clear installation
instructions and exits.

Install Docling (and typical extras):
  pip install -U docling

Depending on your platform/GPU and the Docling features you use, you may also
need torch and other extras. Refer to Docling’s official docs for details.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


def _print_missing_docling_and_exit() -> None:
    sys.stderr.write(
        "\nDocling is not installed.\n"
        "Install it with:\n\n"
        "  pip install -U docling\n\n"
        "Then re-run this script.\n\n"
    )
    sys.exit(2)


def _safe_get_attr(obj: Any, names: List[str]) -> Optional[Any]:
    """Return the first present attribute from names, else None."""
    for n in names:
        if hasattr(obj, n):
            return getattr(obj, n)
    return None


@dataclass
class LayoutBlock:
    page_index: int
    block_index: int
    text: str
    bbox: Optional[List[float]]  # [x0, y0, x1, y1] if available
    type: Optional[str] = None


def extract_with_docling(pdf_path: str) -> Dict[str, Any]:
    """
    Attempt to load and convert the PDF using various Docling APIs.
    Returns a dict with keys: markdown (str), layout (List[LayoutBlock as dict])
    """
    try:
        # Try the DocumentConverter entry point (common in Docling examples)
        from docling.document_converter import DocumentConverter  # type: ignore

        converter = DocumentConverter()
        result = converter.convert(pdf_path)

        # Try common markdown export patterns
        markdown = None
        doc_obj = _safe_get_attr(result, ["document", "doc", "output", "result"])
        if doc_obj is None:
            doc_obj = result

        for candidate in [
            "export_markdown",
            "to_markdown",
            "markdown",
            "as_markdown",
        ]:
            fn = _safe_get_attr(doc_obj, [candidate])
            if callable(fn):
                try:
                    markdown = fn()
                    break
                except TypeError:
                    # Some call styles may require args; ignore
                    pass
            elif isinstance(fn, str):
                markdown = fn
                break

        if markdown is None:
            # Fallback: synthesize Markdown from doc structure
            markdown = _fallback_markdown_from_doc(doc_obj)

        # Attempt to pull layout info
        layout_blocks: List[LayoutBlock] = []

        # Heuristics: locate pages/blocks attributes
        pages = _safe_get_attr(doc_obj, ["pages", "page_list", "document_pages", "_pages"]) or []
        for p_idx, page in enumerate(pages):
            blocks = _safe_get_attr(page, ["blocks", "elements", "items"]) or []
            for b_idx, block in enumerate(blocks):
                text = _safe_get_attr(block, ["text", "content", "to_text"]) or ""
                if callable(text):
                    try:
                        text = text()
                    except Exception:
                        text = ""
                bbox = _safe_get_attr(block, ["bbox", "bounding_box", "box", "rect"]) or None
                # Normalize bbox to list of floats when possible
                bbox_list: Optional[List[float]] = None
                if bbox is not None:
                    try:
                        # Common patterns: tuple/list of 4 numbers, or object with x0,y0,x1,y1
                        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                            bbox_list = [float(b) for b in bbox]
                        else:
                            x0 = float(getattr(bbox, "x0"))
                            y0 = float(getattr(bbox, "y0"))
                            x1 = float(getattr(bbox, "x1"))
                            y1 = float(getattr(bbox, "y1"))
                            bbox_list = [x0, y0, x1, y1]
                    except Exception:
                        bbox_list = None

                block_type = _safe_get_attr(block, ["type", "category", "kind"]) or None
                if callable(block_type):
                    try:
                        block_type = block_type()
                    except Exception:
                        block_type = None

                layout_blocks.append(
                    LayoutBlock(
                        page_index=p_idx,
                        block_index=b_idx,
                        text=str(text) if text is not None else "",
                        bbox=bbox_list,
                        type=str(block_type) if block_type is not None else None,
                    )
                )

        # Fallback: if no page/blocks, attempt to derive from doc-level items (e.g., texts)
        if not layout_blocks:
            texts = _safe_get_attr(doc_obj, ["texts"]) or []
            for b_idx, item in enumerate(texts):
                txt = _safe_get_attr(item, ["text"]) or ""
                # provenance may include page_no and bbox
                prov = _safe_get_attr(item, ["prov", "provenance"]) or []
                page_no = 1
                bbox_list = None
                if prov:
                    p = prov[0]
                    try:
                        page_no = int(getattr(p, "page_no", 1))
                    except Exception:
                        page_no = 1
                    try:
                        bbox = getattr(p, "bbox", None)
                        if bbox is not None:
                            l = float(getattr(bbox, "l"))
                            t = float(getattr(bbox, "t"))
                            r = float(getattr(bbox, "r"))
                            b = float(getattr(bbox, "b"))
                            bbox_list = [l, t, r, b]
                    except Exception:
                        bbox_list = None

                lbl = _safe_get_attr(item, ["label"]) or None
                layout_blocks.append(
                    LayoutBlock(
                        page_index=max(0, page_no - 1),
                        block_index=b_idx,
                        text=str(txt),
                        bbox=bbox_list,
                        type=str(lbl) if lbl is not None else None,
                    )
                )

        return {
            "markdown": markdown or "",
            "layout": [asdict(b) for b in layout_blocks],
        }

    except ModuleNotFoundError:
        _print_missing_docling_and_exit()
    except Exception as e:
        # Second attempt: try an alternative import path if Docling’s API differs
        try:
            from docling.pipeline import DocumentPipeline  # type: ignore

            pipeline = DocumentPipeline()
            result = pipeline.run(pdf_path)

            # Try extracting markdown
            markdown = None
            for obj in [result, _safe_get_attr(result, ["document", "doc"])]:
                if obj is None:
                    continue
                for candidate in [
                    "export_markdown",
                    "to_markdown",
                    "markdown",
                    "as_markdown",
                ]:
                    fn = _safe_get_attr(obj, [candidate])
                    if callable(fn):
                        try:
                            markdown = fn()
                            break
                        except TypeError:
                            pass
                    elif isinstance(fn, str):
                        markdown = fn
                        break
                if markdown:
                    break

            if markdown is None:
                markdown = _fallback_markdown_from_doc(result)

            return {
                "markdown": markdown or "",
                "layout": [],  # Unknown structure for this path; left empty
            }
        except ModuleNotFoundError:
            _print_missing_docling_and_exit()
        except Exception as e2:
            sys.stderr.write(
                f"\nError while running Docling: {e}\nSecondary attempt failed: {e2}\n"
            )
            sys.exit(1)


def _label_name(label_val: Any) -> str:
    """Normalize a label-like value to a short string."""
    if label_val is None:
        return ""
    try:
        # Handles Enums like <DocItemLabel.SECTION_HEADER: 'section_header'>
        if hasattr(label_val, "name"):
            return str(getattr(label_val, "name"))
        if hasattr(label_val, "value"):
            return str(getattr(label_val, "value"))
    except Exception:
        pass
    s = str(label_val)
    # Strip Enum-like wrappers
    if "SECTION_HEADER" in s:
        return "SECTION_HEADER"
    if "TEXT" in s:
        return "TEXT"
    return s


def _fallback_markdown_from_doc(doc_obj: Any) -> str:
    """Build a simple Markdown from doc structure as a robust fallback."""
    lines: List[str] = []

    title = _safe_get_attr(doc_obj, ["name", "title"]) or None
    if isinstance(title, str) and title.strip():
        lines.append(f"# {title.strip()}")
        lines.append("")

    # Prefer ordered traversal of text items if present
    texts = _safe_get_attr(doc_obj, ["texts"]) or []
    if texts:
        for item in texts:
            label = _label_name(_safe_get_attr(item, ["label"]))
            text = _safe_get_attr(item, ["text"]) or ""
            if not isinstance(text, str):
                try:
                    text = str(text)
                except Exception:
                    text = ""
            if label == "SECTION_HEADER":
                level = _safe_get_attr(item, ["level"]) or 1
                try:
                    level = max(1, min(6, int(level)))
                except Exception:
                    level = 1
                lines.append(f"{'#' * level} {text.strip()}")
                lines.append("")
            else:
                if text.strip():
                    lines.append(text.strip())
                    lines.append("")

    # If nothing gathered, attempt page blocks text
    if not lines:
        pages = _safe_get_attr(doc_obj, ["pages", "page_list", "document_pages", "_pages"]) or []
        for p in pages:
            blocks = _safe_get_attr(p, ["blocks", "elements", "items"]) or []
            for block in blocks:
                text = _safe_get_attr(block, ["text", "content"]) or ""
                if callable(text):
                    try:
                        text = text()
                    except Exception:
                        text = ""
                if isinstance(text, str) and text.strip():
                    lines.append(text.strip())
                    lines.append("")

    # Final fallback: doc_obj string repr
    if not lines:
        return str(doc_obj)

    return "\n".join(lines).rstrip() + "\n"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Convert PDF to Markdown and layout (Docling-based)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("pdf", help="Path to input PDF file")
    parser.add_argument(
        "--out-md",
        dest="out_md",
        default=None,
        help="Path to write Markdown output (stdout if omitted)",
    )
    parser.add_argument(
        "--out-layout",
        dest="out_layout",
        default=None,
        help="Path to write layout JSON (omit to skip)",
    )
    parser.add_argument(
        "--ensure-dir",
        action="store_true",
        help="Create parent directories for output paths if missing",
    )

    args = parser.parse_args(argv)

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        sys.stderr.write(f"Input PDF not found: {pdf_path}\n")
        return 2

    result = extract_with_docling(str(pdf_path))

    # Write Markdown
    if args.out_md:
        out_md_path = Path(args.out_md)
        if args.ensure_dir:
            out_md_path.parent.mkdir(parents=True, exist_ok=True)
        out_md_path.write_text(result["markdown"], encoding="utf-8")
        print(f"Markdown written: {out_md_path}")
    else:
        # Print to stdout
        print(result["markdown"])  # noqa: T201

    # Write layout JSON
    if args.out_layout:
        out_layout_path = Path(args.out_layout)
        if args.ensure_dir:
            out_layout_path.parent.mkdir(parents=True, exist_ok=True)
        out_layout_path.write_text(
            json.dumps(result["layout"], indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"Layout JSON written: {out_layout_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
