#!/usr/bin/env python3
"""Extract PDF content with PaddleOCR PP-Structure and emit JSON/Markdown.

The script rasterizes a PDF with pdf2image, runs PaddleOCR's PP-Structure
pipeline page by page, and writes a structured JSON payload plus an optional
Markdown view. Tables, figures, and images are cropped to disk so downstream
pipeline stages can reuse them when building richer chunks.

Usage example:
    python scripts/paddleocr_pdf_to_md.py input.pdf \
        --out-json outputs/sample.json \
        --out-md outputs/sample.md

Prerequisites (install via pip):
    paddleocr>=2.7.0 pdf2image Pillow
The pdf2image package requires the Poppler binaries. Refer to
https://pypi.org/project/pdf2image/ for platform-specific installation steps.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

PPStructureClass = None  # type: ignore
try:  # Defer hard failures until runtime so we can print actionable hints.
    from paddleocr import PPStructure as _PPStructure  # type: ignore
    PPStructureClass = _PPStructure
except (ModuleNotFoundError, ImportError):  # pragma: no cover
    try:
        from paddleocr import PPStructureV3 as _PPStructure  # type: ignore
        PPStructureClass = _PPStructure
    except (ModuleNotFoundError, ImportError):  # pragma: no cover
        try:
            from paddleocr.ppstructure.ppstructure import PPStructure as _PPStructure  # type: ignore
            PPStructureClass = _PPStructure
        except (ModuleNotFoundError, ImportError):  # pragma: no cover
            PPStructureClass = None  # type: ignore

try:
    from pdf2image import convert_from_path  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    convert_from_path = None  # type: ignore

try:
    from PIL import Image  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    Image = None  # type: ignore

import numpy as np

DEPENDENCY_HINT = """
Missing runtime dependencies.

Required packages:
  pip install --upgrade "paddleocr>=2.7" pdf2image Pillow

Poppler is also required by pdf2image. Installation instructions:
  macOS (brew):   brew install poppler
  Ubuntu/Debian:  sudo apt-get install poppler-utils
  Windows:        Download poppler binaries and add to PATH (see pdf2image docs)
"""

ASSET_FILENAME_TEMPLATE = "page-{page:04d}-item-{item:04d}.png"
TEXT_TYPES = {"text", "paragraph", "title", "list", "header", "footer"}
IMAGE_TYPES = {"figure", "image", "picture", "photo", "chart"}
TABLE_TYPES = {"table"}


def _log(msg: str, *, quiet: bool = False) -> None:
    if quiet:
        return
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


def require_dependencies() -> None:
    if PPStructureClass is None or convert_from_path is None or Image is None:
        sys.stderr.write(DEPENDENCY_HINT)
        sys.exit(2)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract PDF content with PaddleOCR.")
    parser.add_argument("pdf", type=Path, help="Path to the source PDF file.")
    parser.add_argument("--out-json", type=Path, help="Destination JSON file.")
    parser.add_argument("--out-md", type=Path, help="Destination Markdown file.")
    parser.add_argument(
        "--assets-dir",
        type=Path,
        help="Directory for cropped assets (defaults near output files).",
    )
    parser.add_argument("--dpi", type=int, default=220, help="Rasterization DPI (default: 220).")
    parser.add_argument(
        "--lang",
        type=str,
        default="en",
        help="Language hint passed to PaddleOCR (default: en).",
    )
    parser.add_argument(
        "--dump-raw",
        type=Path,
        help="Optional path to dump raw PP-Structure output for debugging.",
    )
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logs and PaddleOCR output.")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress messages (errors still shown).")
    args = parser.parse_args(argv)

    if args.out_json is None and args.out_md is None:
        parser.error("--out-json or --out-md must be provided")

    args.pdf = args.pdf.expanduser().resolve()
    if args.out_json:
        args.out_json = args.out_json.expanduser().resolve()
    if args.out_md:
        args.out_md = args.out_md.expanduser().resolve()
    if args.assets_dir:
        args.assets_dir = args.assets_dir.expanduser().resolve()
    if args.dump_raw:
        args.dump_raw = args.dump_raw.expanduser().resolve()
    return args


def ensure_parent(path: Path) -> None:
    if path and not path.exists():
        path.mkdir(parents=True, exist_ok=True)


def choose_output_root(args: argparse.Namespace) -> Path:
    candidates = [p for p in [args.out_json, args.out_md] if p is not None]
    if candidates:
        return candidates[0].parent
    return args.pdf.parent


def resolve_assets_dir(args: argparse.Namespace, output_root: Path) -> Path:
    if args.assets_dir:
        ensure_parent(args.assets_dir)
        return args.assets_dir
    default_dir = output_root / f"{args.pdf.stem}_assets"
    default_dir.mkdir(parents=True, exist_ok=True)
    return default_dir


def pdf_to_images(pdf_path: Path, dpi: int) -> List[Image.Image]:
    pages = convert_from_path(str(pdf_path), dpi=dpi)
    return [page.convert("RGB") for page in pages]


def to_bgr(pil_img: Image.Image) -> np.ndarray:
    rgb = np.array(pil_img.convert("RGB"))
    return rgb[:, :, ::-1].copy()


def points_to_rect(points: Any) -> Optional[Tuple[float, float, float, float]]:
    if points is None:
        return None
    if isinstance(points, dict):
        try:
            x0 = float(points["x0"])
            y0 = float(points["y0"])
            x1 = float(points["x1"])
            y1 = float(points["y1"])
            return x0, y0, x1, y1
        except Exception:
            return None
    if isinstance(points, (list, tuple)) and points:
        if all(isinstance(p, (int, float)) for p in points) and len(points) == 4:
            x0, y0, x1, y1 = map(float, points)
            return x0, y0, x1, y1
        xs: List[float] = []
        ys: List[float] = []
        for pt in points:
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                xs.append(float(pt[0]))
                ys.append(float(pt[1]))
        if xs and ys:
            return min(xs), min(ys), max(xs), max(ys)
    return None


def clamp_rect(rect: Tuple[float, float, float, float], width: int, height: int) -> Tuple[int, int, int, int]:
    x0, y0, x1, y1 = rect
    x0 = max(0, min(width, int(math.floor(x0))))
    y0 = max(0, min(height, int(math.floor(y0))))
    x1 = max(0, min(width, int(math.ceil(x1))))
    y1 = max(0, min(height, int(math.ceil(y1))))
    if x1 <= x0:
        x1 = min(width, x0 + 1)
    if y1 <= y0:
        y1 = min(height, y0 + 1)
    return x0, y0, x1, y1


def normalize_bbox(rect: Tuple[int, int, int, int], width: int, height: int) -> List[int]:
    x0, y0, x1, y1 = rect
    if width == 0 or height == 0:
        return [0, 0, 0, 0]
    return [
        int(round(x0 * 1000 / width)),
        int(round(y0 * 1000 / height)),
        int(round(x1 * 1000 / width)),
        int(round(y1 * 1000 / height)),
    ]


def extract_text_payload(res: Any) -> Tuple[str, Optional[float]]:
    if isinstance(res, list):
        texts: List[str] = []
        confidences: List[float] = []
        for item in res:
            if not isinstance(item, dict):
                continue
            text = item.get("text") or ""
            if text:
                texts.append(str(text))
            conf = item.get("confidence") or item.get("prob") or item.get("score")
            if conf is not None:
                try:
                    confidences.append(float(conf))
                except (TypeError, ValueError):
                    pass
        text_value = "\n".join(texts).strip()
        confidence = None
        if confidences:
            confidence = float(sum(confidences) / len(confidences))
        return text_value, confidence
    if isinstance(res, dict):
        text = res.get("text") or res.get("value")
        conf = res.get("confidence") or res.get("score")
        try:
            confidence = float(conf) if conf is not None else None
        except (TypeError, ValueError):
            confidence = None
        return str(text or "").strip(), confidence
    if isinstance(res, str):
        return res.strip(), None
    return "", None


def extract_table_html(entry: Dict[str, Any]) -> str:
    html_candidate = entry.get("res_html")
    if isinstance(html_candidate, dict):
        html = html_candidate.get("html") or html_candidate.get("structure")
        if isinstance(html, str):
            return html.strip()
    if isinstance(html_candidate, str):
        return html_candidate.strip()
    res = entry.get("res")
    if isinstance(res, dict):
        html = res.get("html") or res.get("structure")
        if isinstance(html, str):
            return html.strip()
    return ""


def save_cropped_asset(
    pil_img: Image.Image,
    rect: Tuple[int, int, int, int],
    assets_dir: Path,
    page_index: int,
    item_index: int,
) -> str:
    assets_dir.mkdir(parents=True, exist_ok=True)
    filename = ASSET_FILENAME_TEMPLATE.format(page=page_index + 1, item=item_index + 1)
    asset_path = assets_dir / filename
    crop = pil_img.crop(rect)
    crop.save(asset_path, format="PNG")
    return str(asset_path)


def process_page(
    engine: "PPStructure",  # type: ignore[name-defined]
    pil_img: Image.Image,
    page_index: int,
    assets_dir: Path,
    base_dir: Path,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    width, height = pil_img.size
    raw_items = engine.predict(to_bgr(pil_img))
    items: List[Dict[str, Any]] = []
    serializable_raw: List[Dict[str, Any]] = []

    for order, entry in enumerate(raw_items):
        serializable_raw.append(_safe_json(entry))
        entry_type = str(entry.get("type") or "unknown").lower()
        # bbox formats vary across versions; try common keys
        rect_raw = (
            points_to_rect(entry.get("bbox"))
            or points_to_rect(entry.get("box"))
            or points_to_rect(entry.get("bbox_layout"))
        )
        if rect_raw is None:
            continue
        rect = clamp_rect(rect_raw, width, height)
        norm = normalize_bbox(rect, width, height)

        text = ""
        confidence: Optional[float] = None
        if entry_type in TEXT_TYPES:
            text, confidence = extract_text_payload(entry.get("res"))
        elif entry_type in TABLE_TYPES:
            text, confidence = extract_text_payload(entry.get("res"))
        elif entry_type in IMAGE_TYPES:
            text, confidence = extract_text_payload(entry.get("res"))
        else:
            text, confidence = extract_text_payload(entry.get("res"))

        item: Dict[str, Any] = {
            "id": f"p{page_index + 1}_i{order + 1}",
            "type": entry_type,
            "page_index": page_index,
            "order": order,
            "bbox": list(rect),
            "bbox_norm": norm,
        }
        if confidence is not None:
            item["confidence"] = confidence
        if text:
            item["text"] = text

        if entry_type in TABLE_TYPES:
            html = extract_table_html(entry)
            if html:
                item["html"] = html
            asset_path = save_cropped_asset(pil_img, rect, assets_dir, page_index, order)
            item["image_path"] = _relativize_path(asset_path, base_dir)
        elif entry_type in IMAGE_TYPES:
            asset_path = save_cropped_asset(pil_img, rect, assets_dir, page_index, order)
            item["image_path"] = _relativize_path(asset_path, base_dir)
        elif entry_type == "title":
            level = entry.get("layout_level") or entry.get("text_level")
            if isinstance(level, (int, float)):
                item["text_level"] = int(level)

        items.append(item)

    return items, serializable_raw


def _safe_json(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_safe_json(v) for v in obj]
    if isinstance(obj, tuple):
        return [_safe_json(v) for v in obj]
    if isinstance(obj, (str, int, float, type(None))):
        return obj
    return repr(obj)


def _relativize_path(path: str, base_dir: Path) -> str:
    rel = os.path.relpath(path, str(base_dir))
    return rel.replace(os.sep, "/")


def build_document(
    pdf_path: Path,
    pages: List[Dict[str, Any]],
    assets_dir: Path,
    output_root: Path,
) -> Dict[str, Any]:
    meta = {
        "source_path": str(pdf_path),
        "source_name": pdf_path.name,
        "asset_dir": _relativize_path(str(assets_dir), output_root),
        "created_at": _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "page_count": len(pages),
    }
    return {"meta": meta, "pages": pages}


def render_markdown(doc: Dict[str, Any], md_path: Path, output_root: Path) -> None:
    lines: List[str] = []
    for page in doc.get("pages", []):
        page_idx = page.get("page_index", 0)
        items = sorted(page.get("items", []), key=lambda itm: itm.get("order", 0))
        if lines:
            lines.append("---")
        lines.append(f"<!-- Page {page_idx + 1} -->")
        for item in items:
            entry_type = item.get("type", "text")
            text = str(item.get("text", "")).strip()
            if entry_type == "title" and text:
                level = int(item.get("text_level", 2))
                level = min(6, max(1, level))
                lines.append(f"{'#' * level} {text}")
            elif entry_type in TABLE_TYPES:
                html = item.get("html")
                if isinstance(html, str) and html.strip():
                    lines.append(html.strip())
                elif text:
                    lines.append(text)
            elif entry_type in IMAGE_TYPES:
                image_rel = item.get("image_path")
                if image_rel:
                    abs_path = (output_root / image_rel).resolve()
                    rel_for_md = os.path.relpath(abs_path, md_path.parent)
                    alt = text or f"Page {page_idx + 1} asset {item.get('order', 0) + 1}"
                    lines.append(f"![{alt}]({rel_for_md.replace(os.sep, '/')})")
                elif text:
                    lines.append(text)
            else:
                if text:
                    lines.append(text)
    content = "\n\n".join(lines).strip() + "\n"
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(content, encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    require_dependencies()

    if not args.pdf.exists():
        sys.stderr.write(f"Input PDF not found: {args.pdf}\n")
        return 1

    output_root = choose_output_root(args)
    output_root.mkdir(parents=True, exist_ok=True)
    assets_dir = resolve_assets_dir(args, output_root)

    _log(f"Rasterizing PDF '{args.pdf.name}' at {args.dpi} DPI...", quiet=args.quiet)
    try:
        pages_images = pdf_to_images(args.pdf, args.dpi)
    except Exception as e:
        sys.stderr.write(f"Failed to rasterize PDF: {e}\n")
        # Common pitfall: Poppler not installed for pdf2image
        sys.stderr.write(DEPENDENCY_HINT)
        return 2
    _log(f"Found {len(pages_images)} page(s). Initializing PaddleOCR PP-Structure...", quiet=args.quiet)
    # Configure PP-Structure with controlled logging if supported by this version.
    try:
        engine = PPStructureClass(lang=args.lang, show_log=args.verbose)  # type: ignore[call-arg]
    except TypeError:
        engine = PPStructureClass(lang=args.lang)  # type: ignore[call-arg]

    pages_payload: List[Dict[str, Any]] = []
    raw_dump: List[Dict[str, Any]] = []

    for page_index, pil_img in enumerate(pages_images):
        _log(f"Processing page {page_index + 1}/{len(pages_images)}...", quiet=args.quiet)
        try:
            items, raw_items = process_page(engine, pil_img, page_index, assets_dir, output_root)
        except Exception as e:
            sys.stderr.write(f"Error on page {page_index + 1}: {e}\n")
            sys.stderr.flush()
            items, raw_items = [], []
        page_payload = {
            "page_index": page_index,
            "width": pil_img.width,
            "height": pil_img.height,
            "items": items,
        }
        pages_payload.append(page_payload)
        raw_dump.append({"page_index": page_index, "items": raw_items})

    document = build_document(args.pdf, pages_payload, assets_dir, output_root)

    if args.out_json:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        with args.out_json.open("w", encoding="utf-8") as fh:
            json.dump(document, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        _log(f"JSON written: {args.out_json}", quiet=args.quiet)

    if args.out_md:
        render_markdown(document, args.out_md, output_root)
        _log(f"Markdown written: {args.out_md}", quiet=args.quiet)

    if args.dump_raw:
        args.dump_raw.parent.mkdir(parents=True, exist_ok=True)
        with args.dump_raw.open("w", encoding="utf-8") as fh:
            json.dump(raw_dump, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        _log(f"Raw PP-Structure dump written: {args.dump_raw}", quiet=args.quiet)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
