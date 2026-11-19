# IngestLab

[![npm version](https://img.shields.io/npm/v/ingestlab)](https://www.npmjs.com/package/ingestlab)
[![MIT license](https://img.shields.io/github/license/ingestlab-dev/ingestlab)](LICENSE)

**PDF to Markdown, video keyframes, and image optimization. No conversion server.**

- **[PDF to GFM Markdown](#pdf-internals-first):** Extract text, tables, form fields, equations, and supported diagrams. Use OCR for scans.
- **[Video to storyboard](#video-keyframes-in-the-browser):** Detect scene changes in MP4/WebM and export timestamped scene and context frames.
- **[Image optimization](#image-optimization):** Resize still images proportionally and return a smaller WebP when possible. Keep animated images unchanged.

Files are processed locally. The browser may download PDF.js, OCR models, or
preview libraries separately.

## Documentation

The usage guide covers supported runtimes, API options and results, multilingual
OCR, form values, PDF assets, video sampling, image output, and the dropzone
widget. [Read the usage guide](https://github.com/ingestlab-dev/ingestlab/blob/main/docs/usage.md).

## Quick Start

| Feature | Browser | Node.js |
| --- | --- | --- |
| [PDF to Markdown, including OCR](#pdf-in-the-browser) | Yes | [Yes](#pdf-in-nodejs) |
| [MP4/WebM video keyframes](#video-keyframes-in-the-browser) | Yes, with a supported codec | No |
| [Image optimization](#image-optimization) | Yes | Yes |

```sh
npm install ingestlab
```

### PDF in Node.js

```js
import { readFile } from 'node:fs/promises';
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
const { markdown } = await lab.parse(await readFile('document.pdf'));
console.log(markdown);
```

Use a Node.js version supported by the installed PDF.js peer. For example,
`pdfjs-dist@6.5.438` requires Node.js 22.13+ on the 22.x line, or Node.js 24+.

### PDF in the Browser

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
For browser script tags, serve the full `dist/` directory and load
`dist/widget.js` as a module. The widget imports sibling chunks.

### Video Keyframes in the Browser

Pass a `File` from a browser file input, or drop an MP4 or WebM file into
the [playground](#playground). Video decoding uses WebCodecs when available
and can fall back to an HTML video element. Both paths require OffscreenCanvas.

```js
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
export async function extractKeyframes(file) {
  const result = await lab.ingest(file);
  if (result.kind !== 'video') throw new Error('Select an MP4 or WebM video.');
  return { scenes: result.scenes, keyframes: result.keyframes };
}
```

Each keyframe has a `timestamp` in seconds and a `blob` containing the frame
image. The scene metadata shows where those frames fit in the video.

### Image Optimization

Use the same API with a browser `File` or Node.js bytes, such as a `Buffer`
from `readFile()`.

```js
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
export async function optimizeImage(input) {
  const result = await lab.ingest(input, { imageMaxEdge: 1600, imageQuality: 0.86 });
  if (result.kind !== 'image') throw new Error('Expected an image.');
  return { blob: result.keyframes[0].blob, width: result.width, height: result.height };
}
```

If the WebP would not be smaller, the result is the original image. This
pipeline optimizes the image itself; it does not extract text or describe
what the image contains.

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

Open [the local playground](http://127.0.0.1:4173/). Drop a PDF to compare
raw GFM with the rendered preview and copy or download the Markdown. Drop
an MP4 or WebM to inspect and download storyboard frames, or drop an image
to preview and download the optimized output. The Markdown preview supports
KaTeX, Mermaid, and GFM task lists. The HTTP server serves static assets only.

Quick-load presets look for the four source PDFs in `demo/samples/` or
`../pdf/` (override with `INGESTLAB_PDF_DIR`). Source documents are not
redistributed with this package. Use the publisher copies:

| Preset | Local filename |
| --- | --- |
| [IRS Form 1040](https://www.irs.gov/pub/irs-pdf/f1040.pdf) | `f1040.pdf` |
| [TI LM358](https://www.ti.com/lit/ds/symlink/lm358.pdf) | `lm358.pdf` |
| [Attention Is All You Need](https://arxiv.org/pdf/1706.03762v7) | `1706.03762v7.pdf` |
| [World Bank Viet Nam](https://www.worldbank.org/en/businessready/economy/viet-nam) | `viet-nam-2025.pdf` |

The demo also detects a local Schedule D fixture and two generated samples
in `../pdf/corpus-150/synthetic/` for three-column tables and ruled scans.
The [benchmark](BENCHMARK.md#150-document-corpus) includes the corpus commands.

## OCR

Set `ocrLangs: ['jpn', 'eng']` for multilingual OCR or
`ocr: false` to skip recognition. `OCR_LANGUAGE_CODES` lists 123 supported
Tesseract models. Set `ocrRuntime.langPath` for self-hosted model files.
OCR accuracy varies with scan quality.

In Node.js, a standard install includes Tesseract and the native canvas
used to render scanned pages. Keep npm's optional dependencies enabled so
canvas can install its platform binary.

## Development

Run `npm test`, `npm run types:check`, `npm run test:media`, and
`npm run build`. See [BENCHMARK.md](BENCHMARK.md) for corpus runs.
