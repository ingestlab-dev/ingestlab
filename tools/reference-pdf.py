"""Generate the independent PyMuPDF4LLM reference outside the npm package."""

import argparse
from pathlib import Path

import pymupdf4llm

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--lang", default="vie+eng")
args = parser.parse_args()

for pdf in sorted(args.source.iterdir()):
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        continue
    target = args.output / pdf.stem
    target.mkdir(parents=True, exist_ok=True)
    print(pdf.name, flush=True)
    markdown = pymupdf4llm.to_markdown(
        str(pdf), ocr_language=args.lang, page_separators=True,
        write_images=True, image_path=str(target),
    )
    (target / "source.md").write_text(markdown, encoding="utf-8")
