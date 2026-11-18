# PDF conversion benchmark

## Demo regression retest

All 18 local PDFs (818 pages) were uploaded via Chromium after separating PDF
form controls from the document preview. Whole-page OCR completed on 435
pages with no conversion errors or unread scan pages. The browser batch used
whole-page OCR; a separate Node batch also enabled OCR for embedded images.
That batch extracted text from 203 image regions and wrote the compact
Markdown exports to `pdf-markdown-output/retested`. Form field IDs no longer
appear in the document view. Figure captions that wrap within their panel
retain the continuation lines.

```sh
INGESTLAB_OCR_CACHE=/tmp/ingestlab-ocr-cache node tools/convert-pdf-folder.mjs ../pdf pdf-markdown-output/retested --ocr-images
node tools/benchmark-pdf.mjs ../pdf pdf-markdown-output/retested /tmp/ingestlab-reference --compact
```

The retest retained 99.01% of normalized native text tokens. This is not an
OCR accuracy score and does not verify every cell, reading order or diagram
relation.

## Numbered vector drawings

The `vector-rebuilt` export links all 106 numbered figures from the two
diagram PDFs (86 and 20) to standalone SVG drawn by replaying PDF.js canvas
operations. The same export links one additional unnumbered SVG. It contains
no raster figure crops or raster page images. One other unnumbered panel
uses a Markdown data table because PDF.js composites part of it into a
bitmap and the SVG exporter rejects embedded raster content.

`tools/check-vector-corpus.mjs` checks numbering and Markdown links, rejects
embedded raster content, and compares each numbered SVG at 2x against the
corresponding region rendered from the PDF. The worst mean max-channel
difference was 0.68% of full scale; the worst fraction of pixels differing by
more than 64/255 in any channel was 0.16%. These are visual measurements,
not a claim that all 106 figures have independently editable chart data or
relationship tables.

## Results on the local fixture corpus

| Check | Result |
| --- | --- |
| Documents and pages converted | 18 PDFs, 818 pages |
| Scanned pages processed by IngestLab OCR | 436; 0 unread pages or OCR failures reported |
| Visual preservation | 818 page renders; 1,375 verified asset links; 0 render failures |
| Native token recall | IngestLab 98.57%; PyMuPDF4LLM 2.1 94.44% (154,362 tokens) |

The metric matches token **counts**, not just vocabulary, after Unicode
normalization and removing Markdown image references and Mermaid source.
The reference text comes from PDF.js native text on pages with at least
20 tokens. This favors text extraction compatibility with PDF.js and is
not a character-error-rate or table-accuracy measurement. Scan-only pages
are not scored. PyMuPDF4LLM outputs were generated with its layout model;
OCR was disabled for three native-text references. The score is not a claim
that IngestLab wins on every file: PyMuPDF4LLM scored higher on the Transformer
paper, the first Vietnamese diagram PDF and the Vietnam scorecard.

Independent checks: PDFium confirmed page counts, including the three
scan-only documents. pdfplumber independently extracted the four printed
bar values and the reference table from the diagram fixture. A visual read
of the source pages confirmed chart labels and the positioning of the math
scripts. The automated fixture check locks Mermaid edges and messages,
exact bar values, the verification table and equation subscripts/exponents.

Unknown raster charts may still need manual transcription: original pixels
are preserved, but editable chart data is not guaranteed. To make a stronger
quality claim, expand the benchmark with held-out documents, manually labeled
OCR samples and ground truth for table cells and reading order.

## Reproduce

From the package checkout, with the local `../pdf` fixtures:

```sh
python3 -m pip install 'pymupdf4llm==2.1'
TESSDATA_PREFIX="$PWD" python3 tools/reference-pdf.py ../pdf /tmp/ingestlab-reference
INGESTLAB_OCR_CACHE=/tmp/ingestlab-ocr-cache node tools/convert-pdf-folder.mjs ../pdf pdf-markdown-output --with-source
node tools/benchmark-pdf.mjs ../pdf pdf-markdown-output /tmp/ingestlab-reference
npm test
npm run test:ocr
```

Use the `eng.traineddata` and `vie.traineddata` fixture files or set
`TESSDATA_PREFIX` to their installed directory. The Python benchmark tooling
is not a runtime dependency and is not included in the npm package.
