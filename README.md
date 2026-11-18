# IngestLab

[![npm version](https://img.shields.io/npm/v/ingestlab)](https://www.npmjs.com/package/ingestlab)
[![MIT license](https://img.shields.io/github/license/ingestlab-dev/ingestlab)](LICENSE)

**100% client-side PDF-to-GFM Markdown. No conversion server.**

Extract text, tables, form fields, equations, and supported diagrams for
document review and RAG pipelines. The browser processes your file locally;
it may download PDF.js, OCR models, or preview libraries separately.

## Quick Start

```sh
npm install ingestlab
```

```js
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
export async function toMarkdown(file) {
  return (await lab.ingest(file, { imageMode: 'none' })).markdown;
}
```

Use a browser bundler. The package uses the PDF.js peer dependency; install
`pdfjs-dist` alongside IngestLab if your package manager does not install peers.
Set `pdfjs.GlobalWorkerOptions.workerSrc` before passing `{ pdfjs }` to
`IngestLab.init()` to use a self-hosted worker instead of the CDN default.
For browser script tags, `dist/widget.js` is a bundled Web Component entry.

## PDF Internals First

IngestLab uses the PDF structure tree for tagged form reading order and
reads AcroForm widgets for actual values and checkbox states.
It can skip `/Artifact` text with `dropArtifacts: true`; this is opt-in
because some PDFs mark real content as artifacts. It normalizes glyphs from
PDF.js and follows Form XObject transforms
before assigning text and vector rules to the page. If tags are incomplete or
absent, 2D layout reconstructs columns and table grids. Scanned content can
use OCR; unsupported visuals may produce labels instead of reconstructed data.

## Real-World Torture Tests

| Fixture | Verified output |
| --- | --- |
| IRS Form 1040 | Section tables, 73 checkbox states, and 126 empty fields without placeholder underscores |
| TI LM358 | Two-column layout, repeated header/footer filtering, pin assignments, and traced connections for selected op-amp schematics |
| arXiv 1706.03762 | LaTeX math blocks and Mermaid for supported attention diagrams |
| World Bank Viet Nam 2025 | Tabular indicators and printed chart scores; supported diagram types can emit Mermaid |

## Playground

```sh
npm ci
npm run demo
```

Open [the local playground](http://127.0.0.1:4173/). Drop a PDF to see its
raw GFM beside the rendered preview, then copy or download the Markdown.
The preview supports KaTeX, Mermaid, and GFM task lists. The HTTP server
serves static assets only.

Quick-load presets look for the four source PDFs in `demo/samples/` or
`../pdf/` (override with `INGESTLAB_PDF_DIR`). Source documents are not
redistributed with this package. Use the publisher copies:

| Preset | Local filename |
| --- | --- |
| [IRS Form 1040](https://www.irs.gov/pub/irs-pdf/f1040.pdf) | `f1040.pdf` |
| [TI LM358](https://www.ti.com/lit/ds/symlink/lm358.pdf) | `lm358.pdf` |
| [Attention Is All You Need](https://arxiv.org/pdf/1706.03762v7) | `1706.03762v7.pdf` |
| [World Bank Viet Nam](https://www.worldbank.org/en/businessready/economy/viet-nam) | `viet-nam-2025.pdf` |

## OCR and Media

Set `ocrLangs: ['jpn', 'eng']` for multilingual OCR or
`ocr: false` to skip recognition. `OCR_LANGUAGE_CODES` lists 123 supported
Tesseract models. Set `ocrRuntime.langPath` for self-hosted model files.
OCR accuracy varies with scan quality.

`lab.ingest()` also accepts MP4/WebM videos and supported images.
Video returns timestamped keyframes and scene boundaries; images retain their
aspect ratio and are converted to WebP only when the result is smaller.

## Development

Run `npm test`, `npm run types:check`, `npm run test:media`, and
`npm run build`. See [BENCHMARK.md](BENCHMARK.md) for corpus runs.
