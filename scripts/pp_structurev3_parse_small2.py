#!/usr/bin/env python3
"""Parse a specific PDF with PaddleOCR PP-StructureV3 and save Markdown.

This script parses the PDF at /Users/aayush.shah/Downloads/small2.pdf and
writes a single concatenated Markdown file to ./output/small2.md. Any page
images referenced in the Markdown are also saved under ./output/ following the
paths provided by the pipeline.

Keep it simple. No extra bells and whistles.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    input_file = Path("/Users/aayush.shah/Downloads/small2.pdf").expanduser()
    output_path = Path("./output").resolve()

    if not input_file.exists() or not input_file.is_file():
        sys.stderr.write(f"Input PDF not found: {input_file}\n")
        return 1

    try:
        from paddleocr import PPStructureV3  # type: ignore
    except Exception as e:
        sys.stderr.write(
            "paddleocr is not available. Install it first (pip install paddleocr).\n"
        )
        sys.stderr.write(f"Import error: {e}\n")
        return 2

    # Create pipeline and run prediction on the PDF.
    pipeline = PPStructureV3()
    results = pipeline.predict(input=str(input_file))

    # Collect markdown data for all pages and any referenced images.
    markdown_list = []
    markdown_images = []
    for res in results:
        md_info = res.markdown
        markdown_list.append(md_info)
        markdown_images.append(md_info.get("markdown_images", {}))

    # Concatenate pages to a single Markdown document.
    markdown_text = pipeline.concatenate_markdown_pages(markdown_list)

    # Write the Markdown file.
    md_file = output_path / f"{input_file.stem}.md"
    md_file.parent.mkdir(parents=True, exist_ok=True)
    md_file.write_text(markdown_text, encoding="utf-8")

    # Save any images referenced by the Markdown.
    for item in markdown_images:
        if not item:
            continue
        for rel_path, image in item.items():
            file_path = output_path / rel_path
            file_path.parent.mkdir(parents=True, exist_ok=True)
            image.save(file_path)

    sys.stdout.write(f"Markdown written: {md_file}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

