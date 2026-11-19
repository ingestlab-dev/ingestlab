# PDF conversion benchmark

## Local Performance & Payload Reduction

Measured locally in the browser playground with 0 bytes of input uploaded to any server.

| Input Size | Pipeline Mode | Local Latency | Payload Reduction |
| :--- | :--- | ---: | ---: |
| 204 KB (203,977 B) | Native PDF to GFM | 85.4 ms | 98% |
| 503 KB (503,284 B) | Native PDF to GFM | 191.1 ms | 95% |
| 985 KB (985,277 B) | Native PDF to GFM | 386.9 ms | 92% |
| 4.15 MB (4,150,801 B) | Native PDF to GFM | 2.15 s | 96% |
| 2.22 MB (2,215,244 B) | Image / Scan OCR | 3.89 s | 98% |
| 4.86 MB (4,862,240 B) | Image / Scan OCR | 23.23 s | 97% |

## 150-document corpus

The added corpus lives at `../pdf/corpus-150`. The 50 public PDFs cover
tax, immigration, electronics, research, and financial reports. The public
manifest records source URLs and SHA-256 hashes. The 100 generated PDFs
cover 10 domains and include merged cells, staggered table panels, missing
rules, shuffled text drawing order, landscape pages, fillable widgets,
continued tables, and raster scans with a margin imprint.

| Corpus | Documents | Pages | Verified |
| --- | ---: | ---: | --- |
| Original fixtures | 18 | 818 | All exported. Regression checks cover Form 1040 section order, Schedule D and adjacent tax tables, and Form 1040-X column assignment. |
| Added public PDFs | 50 | 908 | All exported. Three pages with no text in the annual report were verified blank. |
| Generated vector PDFs | 90 | 100 | 270/270 tables in order, 6,480/6,480 cells, 290/290 spans, 20/20 widget states or values. |
| Generated scan PDFs | 10 | 10 | 20/20 tables in order, 415/480 cells, 20/20 spans. |

The synthetic checks compare each PDF with its generated ground truth.
They compare table sequence, cell coordinates and text, merged spans, and
widget states or values. Scan tables can also be identified by source
bounds, so OCR typos count toward cell accuracy independently of order.
The public corpus run verifies conversion and page coverage. Selected
real forms have separate content and order assertions in the test suite.

### RAG corpus audit

The RAG audit covers all 150 documents instead of only the original 18
fixtures. It checks every emitted chunk, every page and block reference,
chunk ID uniqueness, and every synthetic table anchor against its ground
truth. Scan fixtures use the local `eng.traineddata` model when
`INGESTLAB_TESSDATA_DIR` is set.

| Check | Result |
| --- | ---: |
| Documents and pages | 150 files, 1,018 pages |
| Extracted tables | 1,246 |
| RAG chunks | 24,815 |
| Valid source references | 34,377 / 34,377 |
| Unique chunk IDs | 24,815 / 24,815 |
| Synthetic table anchor recall | 290 / 290 |
| Scan table cells | 415 / 480 |

The remaining scan-cell misses are OCR recognition errors in the deliberately
rotated, margin-stamped raster fixtures. Table boundaries, order, spans and
all 20 scan table anchors remain detected.

```sh
INGESTLAB_TESSDATA_DIR=/path/to/tessdata npm run test:rag:corpus
npm run benchmark:rag:corpus
```

The synthetic-vector retrieval probe uses 270 ground-truth table queries.
All five retrieval measures are 100% for the current RAG chunks.

| Profile | Evidence coverage | Recall@1 | Recall@5 | MRR | Source accuracy@1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `faithful` | 100% | 100% | 100% | 1.000 | 100% |
| `rag` | 100% | 100% | 100% | 1.000 | 100% |

This probe tests exact table anchors and cell labels. The 15-query natural
language benchmark below measures harder cross-domain questions.

```sh
node tools/fetch-pdf-corpus.mjs
python3 tools/make-pdf-corpus.py
node tools/audit-pdf-corpus.mjs ../pdf/corpus-150/synthetic output/pdf/corpus-150/audit.json output/pdf/corpus-150/synthetic --assert-vector
```

The fixture generator uses ReportLab, Pillow, and Poppler. Outputs for the
original and public fixtures are in `output/pdf/corpus-150/original`
and `output/pdf/corpus-150/real`.

## Layout fidelity

The compact exports from the layout audit are in `output/pdf/layout-audit`.
The checks cover reading order, cell contents, control states, caption
continuations, and equation structure.

| Fixture | Layout check |
| --- | --- |
| [ACL P19-1433](https://aclanthology.org/P19-1433.pdf) | Page 1 reads the left column before the right and keeps wrapped words in their paragraph. |
| [NXP PCF8574](https://www.nxp.com/docs/en/data-sheet/PCF8574_PCF8574A.pdf) | Page 4 keeps all 17 pin rows under one four-column header. |
| [USCIS I-9](https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf) | All four citizenship widgets stay unchecked, and the first section heading remains intact. |
| [IRS 941](https://www.irs.gov/pub/irs-pdf/f941.pdf) | The wages label stays on line 2. |
| [CFPB Closing Disclosure](https://files.consumerfinance.gov/f/201311_cfpb_kbyo_closing-disclosure.pdf) | Printed marks stay with the Conventional and Property Taxes options. FHA remains unchecked. |
| Local LM358 datasheet | Page 1 separates the Description and Pin Assignments columns, keeps the SOP-8L package label with the pinout, and drops a prose region misclassified as a schematic. |
| Local Transformer paper | Figure 2 keeps both caption lines. Equation 1 preserves the fraction, exponent, radical, and subscript. |
| Local Vietnamese Land Law scan | Page 2 yields 589 OCR tokens after cropping the separated margin imprint (187 before). The 222 spurious prose tables from the first pass are gone. |

Save the public fixtures as `acl-two-column.pdf`, `nxp-pcf8574.pdf`,
`uscis-i9.pdf`, `irs-f941.pdf`, and `cfpb-closing-disclosure.pdf`.
Publisher URLs may serve revised editions.

```sh
INGESTLAB_PUBLIC_PDF_DIR=/path/to/public-fixtures npm test
INGESTLAB_OCR_CACHE=/tmp/ingestlab-ocr-layout node tools/convert-pdf-folder.mjs ../pdf output/pdf/layout-audit
node tools/benchmark-pdf.mjs ../pdf output/pdf/layout-audit --compact
```

The remaining errors include some form rows with irregular cell boundaries
and character substitutions in noisy scans. Evaluate those against the
source page before using the output for calculations or form completion.

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

## Extended corpus and retrieval benchmark

The extended fixture set at `../pdf/corpus-170` adds 20 generated PDFs for
borderless and nested tables. Its audit covers 50 public documents and 120
generated documents.

| Check | Result |
| --- | ---: |
| Documents and pages | 170 files, 1,038 pages |
| Extracted tables | 1,286 |
| RAG chunks | 24,935 |
| Valid source references | 34,841 / 34,841 |
| Unique chunk IDs | 24,935 / 24,935 |
| Synthetic table anchor recall | 330 / 330 |

```sh
INGESTLAB_TESSDATA_DIR=/path/to/tessdata node tools/audit-rag-corpus.mjs ../pdf/corpus-170
node tools/benchmark-rag-corpus.mjs ../pdf/corpus-170
```

`rankRagChunks` is exported as a deterministic local baseline. It ignores
question stop words, expands common document-language synonyms, boosts section
and product identities, and keeps numeric answers near their parameter labels.

## Retrieval benchmark

15 hand-labeled English queries over the official Form 1040, the untagged
1040 test fixture, the TI LM358 datasheet, and *Attention Is All You Need*.
Both profiles use the same section paths and base
passage extraction. A hit requires the expected document and page and
all labeled evidence inside one passage. OCR and figure reconstruction
were disabled for both runs.

| Profile | Evidence coverage | Recall@1 | Recall@5 | MRR | Source accuracy@1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `faithful` | 100.0% | 93.3% | 100.0% | 0.967 | 93.3% |
| `rag` | 100.0% | 93.3% | 100.0% | 0.956 | 93.3% |

Evidence coverage counts queries with a complete passage anywhere in the
index. Source accuracy checks the document and page of the top result.
Both profiles use local table-context search text, safe abbreviation aliases,
section-aware ranking, numeric-answer boosts, and stable source-derived chunk
IDs. The faithful profile keeps the original Markdown passage as text;
context is indexing metadata only. Duplicate fixtures can legitimately tie
on identical evidence, so top-result source accuracy remains below evidence
coverage for two queries.

```sh
INGESTLAB_PDF_DIR=/path/to/pdf node tools/benchmark-rag.mjs
```
