# IngestLab usage guide

- [Install and choose an API](#install-and-choose-an-api)
- [Convert PDFs](#convert-pdfs)
- [OCR and language models](#ocr-and-language-models)
- [Export PDF assets](#export-pdf-assets)
- [Build a video storyboard](#build-a-video-storyboard)
- [Optimize images](#optimize-images)
- [Embed the browser widget](#embed-the-browser-widget)
- [Runtime and troubleshooting](#runtime-and-troubleshooting)

## Install and choose an API

```sh
npm install ingestlab
```

The package uses ESM. Initialize an instance with `await IngestLab.init()`
and reuse it across files. Install `pdfjs-dist` alongside IngestLab when
your package manager requires you to install peer dependencies explicitly.

| Call | Input | Result |
| --- | --- | --- |
| `IngestLab.init({ pdfjs, docOpts })` | Optional PDF.js module and document options | An instance with `caps` and `route` |
| `lab.parse(bytes, opts)` | PDF bytes as a `Uint8Array` or Node.js `Buffer` | Markdown, page blocks, controls, figures, assets, and stats |
| `lab.ingest(input, opts)` | `File`, `Blob`, `Uint8Array`, or `ArrayBuffer` | A PDF, video, or image result selected by `kind` |

Wrap an `ArrayBuffer` in `new Uint8Array(buffer)` when calling `parse()`.
`ingest()` accepts the buffer directly and identifies the format from its
bytes.

The return fields vary by `kind`. All `ingest()` results include `metrics`
with input and output size, latency, backend, cache information, and an
estimated processing cost saved. The estimate uses configurable per-page or
per-frame rates. [TypeScript declarations](../types/index.d.ts)

## Convert PDFs

Use `parse()` when you need structured tables or blocks grouped by page.
This Node.js example writes GFM to disk and reads detected form controls.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
const result = await lab.parse(await readFile('form.pdf'), {
  imageMode: 'none',
  semanticHtml: true,
  dropHeadersFooters: false,
  onProgress(event) {
    if (event.stage === 'ocr') console.log(event.ocrDone, event.ocrTotal);
  },
  onPage({ page, blocks }) {
    console.log('ready', page, blocks.length);
  },
});

await writeFile('form.md', result.markdown);
for (const control of result.controls) {
  if (control.type === 'checkbox') console.log(control.label, control.checked);
  else console.log(control.label, control.value);
}
```

In a browser, pass a selected PDF `File` to `lab.ingest(file)` for Markdown
and metrics, or pass `new Uint8Array(await file.arrayBuffer())` to `parse()`
for the full result.

| Field | Contents |
| --- | --- |
| `markdown` | GFM with text, tables, and supported Mermaid or LaTeX blocks |
| `pages` and `blocks` | Blocks grouped by page and a flat list. Table blocks expose `rows` and may include `spans`. |
| `controls` | Detected widgets with a page, label, type, value or checked state, and source |
| `ragChunks` | Retrieval passages with section headings and PDF source references when `markdownProfile: 'rag'` is set |
| `richMarkdown` and `formHtml` | Optional output enabled by `semanticHtml: true`. HTML tables can carry `rowspan` and `colspan`. |
| `assets` and `figures` | Exported images and detected figure metadata |
| `documentGraph` | Typed page/block graph with stable IDs, reading order, bbox, confidence, provenance, and table-cell children |
| `recognizers` | Counts and failures from optional formula, chart, diagram, chemistry, handwriting or low-confidence OCR adapters |
| `stats` | Counts for pages, tables, forms, OCR, and visual recovery |

`onPage` fires after a page has passed layout, compatible table stitching and
optional recognizers. It is useful for incremental indexing or UI updates.
The final `markdown`, `pages` and `documentGraph` still contain the complete
document.

| Option | Behavior |
| --- | --- |
| `dropHeadersFooters` | Defaults to `true`. Set it to `false` to keep repeating page text. |
| `dropArtifacts` | Set to `true` to skip text tagged as a PDF artifact. Defaults to `false`. |
| `detectBorderlessTables` | Defaults to `true`. Set it to `false` to disable the borderless table heuristic. |
| `markdownProfile` | Defaults to `'faithful'`. Use `'rag'` for retrieval chunks and reformatted tagged forms. |
| `figures` and `maxFigures` | Enable figure reconstruction and cap the number processed. Reconstruction is enabled by default. |
| `cache` | Set to `false` to bypass cached conversion results. |
| `docOpts` | PDF.js document options such as `standardFontDataUrl` and `cMapUrl`. |

Check `stats.scannedUnread`, `stats.ocrFailed`, and `stats.imageOcrFailed`
when you need to identify incomplete recognition. Check reconstructed figure
data against the source before using it for calculations.

### Retrieval and question answering

Both profiles use the same PDF internals, OCR, reading-order, table, form,
and figure pipeline. The default `faithful` profile also joins layout-split
paragraphs and removes repeated print leaders inside table cells while keeping
the page-level Markdown structure. The `rag` profile adds semantic form
rewrites, section context, overlapping table windows, stable chunk IDs, and
source metadata.

Specialist models can be attached without changing the default lightweight
path. Pass recognizers with a `types` filter and a `recognize()` function. A
recognizer returns block fields such as `text`, `mermaid`, `tableMd`,
`visualContent`, `confidence`, or `prov`. Results are recorded in the graph and
rendered by the selected Markdown profile.

Built-in deterministic recognizers are available for text-layer formulas,
chemical equations and chart data. `createHandwritingRecognizer()` marks likely
handwriting or low-confidence regions for an external model and preserves the
source when no model is configured.

When indexing faithful output with toRagChunks, each table passage keeps its
exact Markdown in text and receives a small neighboring-row searchText window.
This lets a retriever match questions whose evidence spans adjacent form rows
without changing the faithful document shown to users.

Pass `markdownProfile: 'rag'` to either `parse()` or `ingest()`. Index the
section path with each chunk and store the source references as metadata.

```js
const { ragChunks } = await lab.parse(bytes, { markdownProfile: 'rag' });
const passages = ragChunks.map(({ section, text, searchText, sources }) => ({
  text: searchText || [...section, text].join('\n\n'),
  sources,
}));

// Optional deterministic baseline ranker for a local keyword retriever.
import { rankRagChunks } from 'ingestlab';
const topPassages = rankRagChunks(ragChunks, 'What is the total amount?', { limit: 8 });
```

Each chunk has a stable source-derived `id` and `searchText` for indexing. `rankRagChunks(chunks, query)` provides a deterministic local BM25 baseline with phrase, section, and table-value boosts. Each source has a 1-based `page` and a 0-based `blockIndex` in
`parse().pages[page - 1]`. Table references can also have a 0-based
`rowIndex` that counts header rows. A source can include its original
block bounds in top-down page coordinates. A passage can have several
references when it joins text across pages or associates table rows and notes.

For tagged forms, the RAG profile separates instructions from fields,
groups nearby checkbox options, and trims spaced print leaders from form
descriptions. On Form 1040, the standard deduction callout is included with
line 12e, and line 12a retains both checkbox states. Notes without enough
evidence for a row link stay in the section. For geometric tables, the
profile preserves the table in Markdown and repeats headers and vertical
span context in retrieval chunks. OCR and column ordering still depend on
the underlying extraction, and long single blocks can need further splitting
for an embedding model.

Chunk IDs are deterministic for a parsed document. Keep them as the
deduplication key when overlapping table windows are indexed. The repository
also includes 50 public PDFs and 120 generated layout fixtures covering scan
rotation, margin stamps, borderless or partial-rule tables, nested tables and panels,
continued tables, multi-column pages, reversed drawing order, and fillable
widgets.

```sh
INGESTLAB_TESSDATA_DIR=/path/to/tessdata npm run test:rag:corpus
```

## OCR and language models

OCR runs on image-only pages by default. Embedded-image OCR is also enabled
and can recover labels and some diagrams or charts. Use `ocr: false` for
text-layer extraction, or `ocrImages: false` to keep whole-page OCR while
skipping the extra pass over embedded pictures.

Full-page RGB scan images use a native-safe raster path in Node before OCR. If
a Tesseract model cannot be downloaded or loaded, parsing records the failure
in `stats.ocrFailed` and `stats.scannedUnread` instead of terminating the
process. Supply local models with `ocrRuntime.langPath` for offline scans.

```js
import { readFile } from 'node:fs/promises';
import { IngestLab, OCR_LANGUAGE_CODES } from 'ingestlab';

const lab = await IngestLab.init();
console.log(OCR_LANGUAGE_CODES);
const result = await lab.parse(await readFile('scan.pdf'), {
  ocrLangs: ['jpn', 'eng'],
  ocrPageLimit: 20,
  // Return a processed canvas when a scan needs deskew, denoise or thresholding.
  ocrPreprocess: ({ canvas }) => canvas,
});
console.log(result.markdown);
```

The default language set is `vie+eng`. The engine may select English
after probing scanned pages. Passing `ocrLangs` explicitly selects the
requested languages. Use `ocrCacheDir` in Node.js to resume multi-page OCR.

To supply your own models, set `ocrRuntime.langPath` to a model directory
or a browser-accessible URL. Set `gzip: false` for uncompressed files such as
`jpn.traineddata`. A browser deployment can also configure `module`,
`workerPath`, and `corePath` for Tesseract. Keep optional dependencies
enabled on Node.js so the native canvas package can load its platform binary.

## Export PDF assets

`imageMode: 'none'` produces text-focused Markdown. Use `'refs'` for
relative asset links or `'base64'` to embed the assets in Markdown.
`preservePages: true` adds a source render for each PDF page.
`vectorFigures: true` can export supported standalone SVG reconstructions
in Node.js. `skipRasterFigures: true` skips raster figure crops.

Write referenced assets relative to the Markdown file. This Node.js example
creates `export/document.md` and its image files.

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
const doc = await lab.parse(await readFile('document.pdf'), {
  imageMode: 'refs',
  preservePages: true,
});

await mkdir('export', { recursive: true });
for (const asset of doc.assets) {
  const path = join('export', asset.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, asset.bytes);
}
await writeFile('export/document.md', doc.markdown);
```

## Build a video storyboard

Run MP4 or WebM ingestion in a browser with a supported codec. The video
pipeline uses WebCodecs or an HTML video element with OffscreenCanvas.

```js
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
export async function getStoryboard(videoFile) {
  const result = await lab.ingest(videoFile, {
    maxKeyframes: 24,
    contextIntervalUs: 5_000_000,
    keyframeMaxWidth: 960,
    onProgress: ({ stage, mediaDone, mediaTotal }) => {
      console.log(stage, mediaDone, mediaTotal);
    },
  });
  if (result.kind !== 'video') throw new Error('Expected an MP4 or WebM video');
  return result;
}
```

| Option | Behavior |
| --- | --- |
| `sceneThreshold` | Scene-change sensitivity. The default is `0.12`. Lower values accept smaller changes. |
| `maxKeyframes` | Optional upper limit on exported frames. |
| `contextIntervalUs` | Target interval between context frames in microseconds. The default is six seconds. |
| `minGapUs`, `collectGapUs`, and `collectMaxFrames` | Minimum spacing between scene cuts and limits on analysis sampling. |
| `keyframeMaxWidth` and `webpQuality` | Export size and image quality. The default longest edge is 960 pixels. |

`timestamp` is in seconds. Fields ending in `Us` are in microseconds.
Inspect `scenes`, `scenesRepresented`, and `maxFrameGapUs` to evaluate
coverage with your frame budget. Each frame includes an image `Blob` you
can display with an object URL or save.

## Optimize images

Pass an image to `ingest()` in either the browser or Node.js. The optimizer
returns a resized WebP when it is smaller than the original. The fallback
returns the original bytes and dimensions. Supported animated inputs are
preserved.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { IngestLab } from 'ingestlab';

const lab = await IngestLab.init();
const image = await lab.ingest(await readFile('photo.png'), {
  imageMaxEdge: 1200,
  imageQuality: 0.82,
});
if (image.kind !== 'image') throw new Error('Expected an image');

const output = image.keyframes?.[0]?.blob;
if (!output) throw new Error('Missing image output');
await writeFile(image.optimized ? 'photo.webp' : 'photo-original.png',
  new Uint8Array(await output.arrayBuffer()));
```

Use `imageMaxEdge` to set the target longest edge and `imageQuality`
between 0 and 1 to control encoding. The defaults are 1600 and 0.86.
Check `optimized`, `animatedPreserved`, and the returned blob's MIME type
before choosing a filename.

## Embed the browser widget

Import the widget from a browser entry point in your bundler. This registers
the `<ingest-dropzone>` custom element.

```html
<ingest-dropzone
  id="files"
  accept=".pdf,.mp4,.webm,.png,.jpeg,.jpg,.gif,.webp"
  ocr-langs="eng+fra"
  split-preview>
</ingest-dropzone>
<script type="module">
  import 'ingestlab/widget';

  const widget = document.querySelector('#files');
  widget.addEventListener('ingest-result', ({ detail }) => {
    if (detail.kind === 'pdf') console.log(detail.markdown);
  });
  widget.addEventListener('ingest-error', ({ detail }) => console.error(detail));
</script>
```

Use `ingestFile(file)` to process a file programmatically and `result` to
read the latest result. The element also emits `ingest-progress`. For a
static script deployment, serve the whole package `dist/` directory and
include `widget.js` as a module.

For React, pass your React import to the wrapper from `ingestlab/widget`.
To listen for processing events across React versions, use a ref on a
plain `<ingest-dropzone>` element and attach native event listeners in an
effect.

Set `pdfjs-src` to the URL of `pdf.min.mjs` to self-host PDF.js and put
the matching `pdf.worker.min.mjs` beside it. Use `pdfjs-stdfonts` for the
standard font directory. The widget supports `ocr-src`, `ocr-worker-src`,
`ocr-core-src`, and `ocr-lang-src` for self-hosted OCR assets, along with
`ocr-lang-gzip` for compressed language models.

## Runtime and troubleshooting

- **Node.js** supports PDF and image ingestion from Node.js 18. The default
  `pdfjs-dist@4.8.x` peer supports Node.js 18 and newer. If you inject a newer
  PDF.js module, use the Node.js version required by that module and match its
  worker, standard-font, CMap, and WASM assets.
- **PDF.js worker errors** can occur when the worker and PDF.js module use
  different versions. For the direct API, set
  `pdfjs.GlobalWorkerOptions.workerSrc` and pass that module as
  `await IngestLab.init({ pdfjs })`.
- **Empty scans** can indicate missing language models, disabled OCR, or an
  OCR page limit. Check the OCR counters in `stats` and the configured
  model path.
- **Missing images in Markdown** are often relative-path issues. For
  `imageMode: 'refs'`, place each asset at its returned path beside the Markdown.
- **Video decoding errors** may indicate that the browser lacks support
  for the video's codec. Try the file in a browser that can play it.

See the runnable local playground in the [README](../README.md#playground)
and the [benchmark](../BENCHMARK.md) for PDF examples.

