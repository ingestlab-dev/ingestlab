# IngestLab document and media roadmap

This is the working task board for the PDF-to-Markdown core and the video
keyframe branch. A task moves to `DONE` only after its stated artifact and
metric are verified. Public comparisons use the same corpus and protocol for
every engine.

| ID | Phase | Task | Deliverable | Metric / acceptance gate | Status |
| --- | --- | --- | --- | --- | --- |
| P0.1 | Measurement | Build a stratified corpus for native PDFs, scans, phone photos, forms, tables, formulas, charts, diagrams, datasheets, papers, legal and financial reports | Versioned manifest, source hashes, ground truth | Every file has category, page count, expected elements and licensing record | IN PROGRESS |
| P0.2 | Measurement | Add text, OCR, reading-order, table, formula, element, bbox and cross-page metrics | Reproducible evaluator | Native and OCR slices are separated; graph evaluator reports table cell recall, bbox IoU and table order. Text CER, TEDS, formula and full reading-order scorers remain | IN PROGRESS |
| P0.3 | Measurement | Add RAG and runtime measurements | Benchmark report | Retrieval metrics exist; performance runner now reports page streaming, latency, pages/s, OCR confidence and heap usage | IN PROGRESS |
| P0.4 | Measurement | Reproduce a public OXR-like subset | Cross-engine report | Same pages, options, hardware class and scoring code. No SOTA claim before this gate | TODO |
| P1.1 | Document graph | Keep stable typed elements, page/block order, bbox, confidence and provenance | `documentGraph` API | Stable IDs, valid source refs and deterministic replay | DONE |
| P1.2 | Document graph | Expand element types | Typed graph for formula, chart, diagram, caption, footnote, code, chemistry, stamp and form controls | Typed graph, control graph, visual metadata and valid parent/child relations implemented; specialist chemistry/handwriting labels remain | IN PROGRESS |
| P1.3 | Document graph | Add source spans and cross-page relations | Character/word spans, links and continuation edges | Cross-page table continuation relations are implemented; character/word spans remain | IN PROGRESS |
| P2.1 | Layout | Improve multi-column, vertical text, sidebars and margin notes | Region graph and reading-order resolver | Graph now records containment relations; column/vertical reading-order scorer remains | IN PROGRESS |
| P2.2 | Layout | Handle A3, nested regions, continued sections and repeated headers/footers | Page normalization and region nesting | Continued table/page relations, containment graph and repeated chrome handling exist; scorer remains | IN PROGRESS |
| P2.3 | Layout | Add skew, dewarp, denoise and orientation routing | Scan preprocessing stages | OCR CER and table cell accuracy improve on scan/photo slices | TODO |
| P3.1 | Visual semantics | Convert math text to clean LaTeX | Formula recognizer and Markdown renderer | Native font remapping, fraction recovery, superscript/subscript and TeX normalization are implemented; specialist model scorer remains | IN PROGRESS |
| P3.2 | Visual semantics | Add mhchem, SMILES/SVG and code-block recognizers | Chemical and code element adapters | Generic specialist adapter contract exists; domain-specific mhchem/SMILES model adapters remain | IN PROGRESS |
| P3.3 | Visual semantics | Reconstruct charts, circuits, diagrams and flowcharts | Table data, relation graph and Mermaid output | Built-in figure reconstruction plus specialist adapter contract; domain scorer remains | IN PROGRESS |
| P4.1 | OCR | Add orientation, region crop, adaptive threshold and denoise passes | Confidence-aware OCR pipeline | OCR confidence, ROI, retry and an `ocrPreprocess` hook are implemented; built-in orientation/dewarp passes remain | IN PROGRESS |
| P4.2 | OCR | Add language probing, retry policy and figure-label OCR | Adaptive language/model routing | Language probing, rule-aware retry, confidence-triggered alternate pass, cache reuse and figure-label OCR exist; language/model scorer remains | IN PROGRESS |
| P4.3 | OCR | Add recognizer adapter interface | Local, browser and optional server adapters | Tesseract remains fallback and output schema stays stable | TODO |
| P5.1 | Tables/forms | Merge continued, borderless, nested and partial-rule tables | Cell graph with rowspan/colspan and continuation links | Compatible continued tables are stitched before Markdown/RAG rendering; merge scoring remains | IN PROGRESS |
| P5.2 | Tables/forms | Improve field, checkbox, input, signature and date association | Form graph and Markdown controls | Controls now enter the graph and RAG search evidence; field/value benchmark remains | IN PROGRESS |
| P5.3 | Tables/forms | Preserve faithful and RAG renderers from one graph | GFM, HTML and RAG serializers | Faithful text unchanged, RAG evidence complete | TODO |
| P6.1 | Performance | Parse native text first and route only hard pages/regions to OCR | Confidence-based scheduler | Native-first OCR routing, confidence metadata/retry and performance runner implemented; memory scheduler remains | IN PROGRESS |
| P6.2 | Performance | Add page streaming, worker pools, page cache and model warm cache | Incremental parse API | `onPage` streaming callback is implemented; worker/page-memory scheduling remains | IN PROGRESS |
| P6.3 | Performance | Route WebGPU/WASM only when measured beneficial | Capability policy and fallback matrix | Same output, lower measured latency, no mandatory GPU | TODO |
| P7.1 | Video | Improve scene cuts, shot clustering and keyframe diversity | Adaptive scene timeline | Existing scene/cut/diversity tests pass; production corpus coverage still pending | IN PROGRESS |
| P7.2 | Video | Add OCR/text density, saliency and optional transcript timestamps | Evidence-ranked keyframes | Lightweight edge/contrast saliency ranks and annotates context frames; OCR density/transcript adapters remain | IN PROGRESS |
| P7.3 | Video | Add uniform fallback and scene summary metadata | Stable output for difficult codecs/videos | Scene coverage, max frame gap, saliency and fallback metadata implemented; transcript adapter remains | IN PROGRESS |
| R1 | Release | Publish benchmark, docs and examples for each profile | Versioned report and API docs | Every claim links to reproducible command and corpus revision | TODO |

## Ordering

Work proceeds P0 → P1 → P2/P4/P5 → P3 → P6 → P7. P2, P4 and P5 can run in
parallel after the graph contract is stable. P3 recognizers must consume graph
regions and return confidence and provenance. P6 optimization starts only
after correctness metrics exist. Video remains a separate branch and must not
slow the native PDF path.
