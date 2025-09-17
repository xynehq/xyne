#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
PDF -> Multimodal export with Docling
- Extracts page text, tables, and crops images/figures from page renders
- Emits:
    1) scratch/<doc_stem>/document.md          (full Markdown)
    2) scratch/<doc_stem>/document.jsonl       (one JSON record per page)
    3) scratch/<doc_stem>/tables/page-<n>-table-<k>.md  (tables as Markdown)
    4) scratch/<doc_stem>/tables/page-<n>-table-<k>.csv (tables as CSV)
    5) scratch/<doc_stem>/images/page-<n>-img-<k>.png  (cropped figures)
- Also writes a parquet snapshot of the multimodal rows (for ML pipelines).
"""

import argparse
import datetime as dt
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pandas as pd
from PIL import Image

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.utils.export import generate_multimodal_pages

# -------- Tunables --------
IMAGE_RESOLUTION_SCALE = 2.0  # 1.0 ~ 72DPI; 2.0 ~ 144DPI; increase for sharper crops
FIGURE_LIKE_LABELS = {"figure", "image", "picture", "graphic"}  # segment labels treated as images
TABLE_LIKE_LABELS = {"table"}
PARQUET_ENGINE = "pyarrow"  # or "fastparquet"
# --------------------------


log = logging.getLogger("docling-mm-export")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


def safe_label(seg: Dict[str, Any]) -> str:
    """
    Docling segment dicts may carry label/type under slightly different keys
    depending on pipeline versions. Normalize to lowercase string.
    """
    for k in ("label", "type", "category", "kind"):
        if k in seg and isinstance(seg[k], str):
            return seg[k].lower()
    return ""


def pil_crop_from_bbox(page_img: Image.Image, bbox) -> Image.Image:
    """
    Crop from a bbox that may be:
      - dict with x, y, width, height (pixel coords)
      - tuple/list with (x0, y0, x1, y1) normalized to [0,1]
    """
    if isinstance(bbox, dict):
        x = int(round(bbox.get("x", 0)))
        y = int(round(bbox.get("y", 0)))
        w = int(round(bbox.get("width", 0)))
        h = int(round(bbox.get("height", 0)))
        x2, y2 = x + w, y + h
    elif isinstance(bbox, (tuple, list)) and len(bbox) == 4:
        x0, y0, x1, y1 = bbox
        # assume relative coords
        x = int(round(x0 * page_img.width))
        y = int(round(y0 * page_img.height))
        x2 = int(round(x1 * page_img.width))
        y2 = int(round(y1 * page_img.height))
    else:
        raise ValueError(f"Unsupported bbox format: {bbox}")

    x, y = max(0, x), max(0, y)
    x2, y2 = min(page_img.width, x2), min(page_img.height, y2)
    if x2 <= x or y2 <= y:
        return Image.new("RGB", (1, 1), (255, 255, 255))
    return page_img.crop((x, y, x2, y2))


def cells_to_table_grid(cells: List[Dict[str, Any]]) -> List[List[str]]:
    """
    Convert Docling page_cells (list of cells with row/col indices) into a 2D grid.
    Expects each cell to carry at least: row, col, text (and optionally rowSpan/colSpan).
    We will expand spans by repeating cell text in covered positions for Markdown/CSV export.
    """
    if not cells:
        return []

    max_row = 0
    max_col = 0
    for c in cells:
        r = int(c.get("row", 0))
        cidx = int(c.get("col", 0))
        rs = int(c.get("rowSpan", 1))
        cs = int(c.get("colSpan", 1))
        max_row = max(max_row, r + rs - 1)
        max_col = max(max_col, cidx + cs - 1)

    grid = [["" for _ in range(max_col + 1)] for _ in range(max_row + 1)]

    for c in cells:
        text = str(c.get("text", "") or "").strip()
        r = int(c.get("row", 0))
        cidx = int(c.get("col", 0))
        rs = int(c.get("rowSpan", 1))
        cs = int(c.get("colSpan", 1))
        for dr in range(rs):
            for dc in range(cs):
                rr = r + dr
                cc = cidx + dc
                if 0 <= rr < len(grid) and 0 <= cc < len(grid[0]):
                    # simple fill: replicate text across span (good enough for markdown/csv)
                    grid[rr][cc] = text
    return grid


def grid_to_markdown(grid: List[List[str]]) -> str:
    if not grid:
        return ""
    # use first non-empty row for header fallback
    header = None
    for row in grid:
        if any(cell.strip() for cell in row):
            header = row
            break
    if header is None:
        header = [""] * len(grid[0])

    md_lines = []
    md_lines.append("| " + " | ".join(cell.replace("\n", " ").strip() for cell in header) + " |")
    md_lines.append("| " + " | ".join("---" for _ in header) + " |")

    for row in grid[1:]:
        md_lines.append("| " + " | ".join(cell.replace("\n", " ").strip() for cell in row) + " |")

    return "\n".join(md_lines)


def write_csv(grid: List[List[str]], csv_path: Path):
    import csv

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        for row in grid:
            w.writerow(row)


def build_markdown_page(
    page_no: int,
    content_md: str,
    table_md_blocks: List[Tuple[int, str]],
    image_rel_paths: List[Tuple[int, str]],
) -> str:
    """
    Compose a readable markdown section for a page.
    We append table blocks and images at the end of the page section.
    """
    lines = [f"\n## Page {page_no}", ""]
    if content_md and content_md.strip():
        lines.append(content_md.strip())
        lines.append("")

    if table_md_blocks:
        lines.append("### Tables")
        for idx, md in table_md_blocks:
            lines.append(f"\n**Table {idx}**\n\n{md}\n")
    if image_rel_paths:
        lines.append("### Figures")
        for idx, path in image_rel_paths:
            lines.append(f"\n**Figure {idx}**\n\n![]({path})\n")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Docling PDF -> multimodal export (Markdown + JSON + Parquet)")
    parser.add_argument("pdf", help="Path to input PDF")
    parser.add_argument("--out", default="scratch", help="Output root directory (default: scratch)")
    parser.add_argument("--scale", type=float, default=IMAGE_RESOLUTION_SCALE, help="Rendering scale (1.0 ~ 72DPI)")
    parser.add_argument("--parquet", action="store_true", help="Also write a parquet snapshot of rows")
    args = parser.parse_args()

    pdf_path = Path(args.pdf).expanduser().resolve()
    if not pdf_path.exists():
        raise FileNotFoundError(f"Input not found: {pdf_path}")

    out_root = Path(args.out).expanduser().resolve()
    doc_stem = pdf_path.stem
    out_dir = out_root / doc_stem
    img_dir = out_dir / "images"
    tbl_dir = out_dir / "tables"
    out_dir.mkdir(parents=True, exist_ok=True)
    img_dir.mkdir(parents=True, exist_ok=True)
    tbl_dir.mkdir(parents=True, exist_ok=True)

    # Configure Docling: keep page images so we can crop figures;
    # bump scale for sharper crops; enable images generation.
    pipeline_options = PdfPipelineOptions()
    pipeline_options.images_scale = float(args.scale)
    pipeline_options.generate_page_images = True

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )

    log.info("Converting PDF with Docling …")
    conv_res = converter.convert(pdf_path)

    # We’ll build:
    # - consolidated markdown
    # - JSONL (one page record)
    # - optional parquet
    jsonl_path = out_dir / "document.jsonl"
    md_path = out_dir / "document.md"
    jsonl_f = jsonl_path.open("w", encoding="utf-8")

    all_rows: List[Dict[str, Any]] = []
    md_pages: List[str] = []

    # Iterate multimodal pages
    for (
        content_text,
        content_md,
        content_dt,
        page_cells,
        page_segments,
        page,
    ) in generate_multimodal_pages(conv_res):
        pnum = page.page_no  # usually 0-based internally
        page_no_display = pnum + 1

        # ---- TABLES ----
        # Docling hands us a flat list of cells for the page (possibly multiple tables).
        # We'll attempt to cluster by 'tableId' if present; otherwise treat all cells as one table.
        tables_markdown_blocks: List[Tuple[int, str]] = []
        table_csv_paths: List[Path] = []

        # Group by table id if available
        buckets: Dict[str, List[Dict[str, Any]]] = {}
        for c in (page_cells or []):
            tid = str(c.get("tableId", "0"))
            buckets.setdefault(tid, []).append(c)

        if not buckets and page_cells:
            buckets["0"] = page_cells

        for k, cells in sorted(buckets.items(), key=lambda kv: kv[0]):
            grid = cells_to_table_grid(cells)
            if grid:
                md_block = grid_to_markdown(grid)
                tables_markdown_blocks.append((int(k) if k.isdigit() else len(tables_markdown_blocks) + 1, md_block))
                csv_path = tbl_dir / f"page-{page_no_display}-table-{k}.csv"
                write_csv(grid, csv_path)
                table_csv_paths.append(csv_path)
                # also save each table markdown
                (tbl_dir / f"page-{page_no_display}-table-{k}.md").write_text(md_block, encoding="utf-8")

        # ---- IMAGES/FIGURES ----
        # We crop figure-like segments from the rendered page image.
        figure_rel_paths: List[Tuple[int, str]] = []
        figure_idx = 1
        page_img = page.image  # PIL.Image at the requested scale

        for seg in (page_segments or []):
            label = safe_label(seg)
            if label in FIGURE_LIKE_LABELS:
                bbox = seg.get("bbox") or seg.get("box") or {}
                try:
                    crop = pil_crop_from_bbox(page_img, bbox)
                except Exception as e:
                    log.warning(f"Page {page_no_display}: failed to crop figure bbox={bbox}: {e}")
                    continue
                img_name = f"page-{page_no_display}-img-{figure_idx}.png"
                crop_path = img_dir / img_name
                try:
                    crop.save(crop_path)
                    figure_rel_paths.append((figure_idx, f"images/{img_name}"))
                    figure_idx += 1
                except Exception as e:
                    log.warning(f"Page {page_no_display}: failed to save figure: {e}")

        # ---- Build page markdown ----
        md_page = build_markdown_page(
            page_no=page_no_display,
            content_md=content_md or "",
            table_md_blocks=tables_markdown_blocks,
            image_rel_paths=figure_rel_paths,
        )
        md_pages.append(md_page)

        # ---- Build JSON page record ----
        dpi = page._default_image_scale * 72  # exposed by docling’s page
        page_record = {
            "document": conv_res.input.file.name,
            "document_hash": conv_res.input.document_hash,
            "page_index": pnum,
            "page_number": page_no_display,
            "dpi": dpi,
            "size_points": {"width": page.size.width, "height": page.size.height},
            "image": {
                "width": page.image.width,
                "height": page.image.height,
                # NOTE: we do not inline bytes in JSONL to keep it small; we write image crops to disk instead
            },
            "text": content_text,
            "markdown": content_md,
            "structured": content_dt,  # docling’s structured content (dict/tree)
            "tables": {
                "count": len(tables_markdown_blocks),
                "csv_paths": [str(p.relative_to(out_dir)) for p in table_csv_paths],
                "markdown_blocks": [md for _, md in tables_markdown_blocks],
            },
            "figures": {
                "count": len(figure_rel_paths),
                "image_paths": [rel for _, rel in figure_rel_paths],
            },
            "segments": page_segments,  # raw segments (labels, bboxes, etc.)
        }

        jsonl_f.write(json.dumps(page_record, ensure_ascii=False) + "\n")
        all_rows.append(page_record)

    jsonl_f.close()

    # Write consolidated markdown
    doc_title = f"# {pdf_path.name}\n\n_Exported: {dt.datetime.now():%Y-%m-%d %H:%M:%S}_\n"
    (out_dir / "document.md").write_text(doc_title + "\n".join(md_pages) + "\n", encoding="utf-8")

    # Optional parquet snapshot for ML
    if args.parquet:
        # flatten a bit for Parquet; keep heavy lists out
        flat_rows = []
        for r in all_rows:
            flat_rows.append(
                {
                    "document": r["document"],
                    "document_hash": r["document_hash"],
                    "page_index": r["page_index"],
                    "page_number": r["page_number"],
                    "dpi": r["dpi"],
                    "image_width": r["image"]["width"],
                    "image_height": r["image"]["height"],
                    "text": r.get("text", ""),
                    "markdown": r.get("markdown", ""),
                    "tables_count": r["tables"]["count"],
                    "figures_count": r["figures"]["count"],
                    "tables_csv_paths": r["tables"]["csv_paths"],
                    "figures_image_paths": r["figures"]["image_paths"],
                }
            )
        df = pd.json_normalize(flat_rows)
        parquet_path = out_dir / f"multimodal_{dt.datetime.now():%Y-%m-%d_%H%M%S}.parquet"
        df.to_parquet(parquet_path, engine=PARQUET_ENGINE)
        log.info(f"Parquet written: {parquet_path}")

    log.info(f"Done. Outputs in: {out_dir}")
    log.info(f"- Markdown:   {md_path}")
    log.info(f"- JSONL:      {jsonl_path}")
    log.info(f"- Images:      {img_dir}")
    log.info(f"- Tables:      {tbl_dir}")


if __name__ == "__main__":
    main()
