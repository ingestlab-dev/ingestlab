// Type definitions for ingestlab v0.2.0 (hand-written; the runtime is ESM + JSDoc).

export const VERSION: string;
/** Built-in Tesseract LSTM model codes, including script/vertical variants. */
export const OCR_LANGUAGE_CODES: readonly string[];

export interface Word {
  str: string;
  x0: number;
  x1: number;
  /** baseline y, top-down in page pixels (scale 1) */
  y: number;
  size: number;
  mono: boolean;
}

export interface HeadingBlock {
  type: 'heading';
  level: number;
  text: string;
  viaVision?: boolean;
}
export interface ParagraphBlock {
  type: 'paragraph';
  text: string;
  viaVision?: boolean;
}
export interface ListBlock {
  type: 'list';
  items: { text: string; ordered: boolean; nested: boolean; marker: string | null }[];
}
export interface CodeBlock {
  type: 'code';
  lines: string[];
}
export interface TableBlock {
  type: 'table';
  kind: 'ruled' | 'borderless';
  rows: string[][];
  form?: boolean;
  keepColumns?: boolean;
  tagged?: boolean;
  /** merged-cell spans (colspan/rowspan) recovered from partial rules */
  spans?: { r: number; c: number; rowspan: number; colspan: number }[];
  meta?: {
    headerRows?: number;
    groupRows?: number[];
    totalRows?: number[];
    rotatedHeaders?: { col: number; text: string; isRotatedHeader: true }[];
    diagonal?: { a: string; b: string } | null;
  };
}
export interface FigureBlock {
  type: 'figure';
  vectorPath?: string;
  visualContent?: VisualContent;
  /** region kind (chart | diagram | schematic | photo | caption | ...) or the fine kind2 */
  kind?: string | null;
  /** Source-PDF caption when no visual region could be matched. */
  caption?: string;
  sourceCaption?: string;
  sourceText?: string;
  assetPath?: string;
  /** Approximate detected region dimensions in PDF points. */
  bboxW?: number;
  bboxH?: number;
  mermaid?: string | null;
  /** normalized vector redraw (specialized kinds; preview only, never in markdown) */
  svg?: string | null;
  /** circuit | timing | pinout | gauge | chart | flowchart | uml | geometry | gantt | sankey | ... */
  kind2?: string | null;
  /** reconstructed data table (pinout, netlist, gauge, chart, gantt, sankey) */
  tableMd?: string | null;
  /** detected figure metadata; pixels are intentionally not included */
  data?: Record<string, unknown> | null;
}
export interface FormGridBlock {
  type: 'form_grid';
  title?: string | null;
  rows: { label: string; value: string; comb?: number }[][];
}
export interface FormMatrixBlock {
  type: 'form_matrix';
  title?: string | null;
  rows: string[][];
}
export interface WorksheetBlock {
  type: 'worksheet';
  title?: string | null;
  rows: { code: string; label: string; amount: string | null; leader: boolean; indent: boolean; underline: false | 'single' | 'double' }[];
}
export interface KvPanelBlock {
  type: 'kv_panel';
  rows: string[][];
}
export interface FormSectionBlock {
  type: 'form_section';
  title: string;
  note?: string;
}
export interface AsideBlock {
  type: 'aside';
  text: string;
}
export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | TableBlock
  | FigureBlock
  | FormGridBlock
  | FormMatrixBlock
  | WorksheetBlock
  | KvPanelBlock
  | FormSectionBlock
  | { type: 'image'; text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; assetPath?: string; ocrLines?: string[];
      rasterVisual?: { kind: 'diagram'; nodes: string[]; edges: [from: number, to: number, directed: boolean][]; labels: string[] } |
        { kind: 'table' | 'radial' | 'radial-score' | 'bar' | 'pie'; headers: string[]; rows: string[][]; partial?: boolean; approximate?: boolean } }
  | { type: 'source_page'; page: number; assetPath: string }
  | AsideBlock;

export interface PdfAsset {
  path: string;
  bytes: Uint8Array;
  page: number;
  kind?: 'vector-reconstruction';
  area?: { x: number; y: number; w: number; h: number };
  caption?: string;
}

export interface Caps {
  webgpu: boolean;
  gpuAdapter: string;
  wasmSimd: boolean;
  opfs: boolean;
  workers: boolean;
  webcodecs: boolean;
  webcodecsEncoder: boolean;
}

export interface Route {
  engine: 'webgpu' | 'wasm-simd' | 'wasm';
  vision: 'onnx-webgpu' | 'onnx-wasm' | 'off';
  cache: 'opfs' | 'memory';
  /** video keyframe tier (feature-detected) */
  video: 'webgpu-webcodecs' | 'webcodecs-2d' | 'rvfc-webgpu' | 'rvfc-2d' | 'seek-2d';
}

export interface IngestMetrics {
  backend: string;
  latencyMs: number;
  originalBytes: number;
  outputBytes: number;
  compressionRatio: number;
  /** estimate, configurable: usdPerFrameCloud / usdPerPageCloud */
  estimatedSavedUsd: number;
  cacheHit: boolean;
}

export interface Keyframe {
  /** seconds */
  timestamp: number;
  timestampUs: number;
  diffScore: number;
  isSceneCut: boolean;
  blob: Blob | null;
  sceneId?: number;
  reason?: 'scene' | 'context';
}

export interface VideoScene {
  id: number;
  startUs: number;
  endUs: number;
  diffScore: number;
}

export interface PdfControl {
  page: number;
  type: 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' | 'button';
  bbox: { x0: number; y0: number; x1: number; y1: number };
  source: 'acroform' | 'vector';
  name?: string | null;
  label: string;
  labelSource: 'pdf-label' | 'field-name' | 'geometry';
  value?: string | string[] | boolean | null;
  checked?: boolean;
  exportValue?: string | null;
  required?: boolean;
  readOnly?: boolean;
  multiple?: boolean;
  options?: { value: string; label: string }[];
}

export interface PdfSource {
  /** 1-based PDF page number. */
  page: number;
  /** 0-based index in the page's original blocks. */
  blockIndex: number;
  /** 0-based index in the original table, including header rows. */
  rowIndex?: number;
  /** Original block bounds in top-down page coordinates, when available. */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export interface RagChunk {
  /** Stable source-derived identifier for deduplicating indexed passages. */
  id: string;
  text: string;
  section: string[];
  /** Search-oriented text with section context and safe abbreviation aliases. */
  searchText: string;
  sources: PdfSource[];
  kind?: 'text' | 'table' | 'instruction';
  tableRowRange?: { start: number; end: number };
}

export interface DocumentGraphElement {
  id: string;
  type: string;
  text: string;
  page: number;
  blockIndex: number;
  order?: number;
  rowIndex?: number;
  columnIndex?: number;
  parentId?: string;
  confidence?: number;
  provenance?: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  sources?: PdfSource[];
  children?: string[];
  kind?: string;
  kind2?: string | null;
}

export interface DocumentGraph {
  version: 1;
  fingerprint?: string;
  elements: DocumentGraphElement[];
  pages: { page: number; width?: number; height?: number; elements: string[] }[];
}

export function rankRagChunks(chunks: RagChunk[], query: string, options?: {
  limit?: number;
}): RagChunk[];

export interface IngestResult {
  controls?: PdfControl[];
  richMarkdown?: string;
  formHtml?: string;
  kind: 'pdf' | 'video' | 'image';
  markdown?: string;
  ragChunks?: RagChunk[];
  assets?: PdfAsset[];
  keyframes?: Keyframe[];
  pages?: number;
  stats?: ParseStats;
  framesProcessed?: number;
  sceneCuts?: number;
  scenes?: VideoScene[];
  scenesRepresented?: number;
  maxFrameGapUs?: number;
  optimized?: boolean;
  animatedPreserved?: boolean;
  durationUs?: number;
  width?: number;
  height?: number;
  metrics: IngestMetrics;
}

export interface IngestOpts extends ParseOpts {
  sceneThreshold?: number;
  maxKeyframes?: number;
  minGapUs?: number;
  /** Include local motion peaks above this threshold in addition to scene and context frames. */
  fillThreshold?: number;
  /** Target interval between context frames (default 6 seconds). */
  contextIntervalUs?: number;
  collectGapUs?: number;
  collectMaxFrames?: number;
  /** Maximum longest edge of an exported frame. */
  keyframeMaxWidth?: number;
  webpQuality?: number;
  /** Target longest edge when the compressed version is smaller (default 1600). */
  imageMaxEdge?: number;
  imageQuality?: number;
  cache?: boolean;
  /** estimate override: USD saved per processed video frame (default 0.0008) */
  usdPerFrameCloud?: number;
  /** estimate override: USD saved per PDF page (default 0.003) */
  usdPerPageCloud?: number;
  onProgress?: (ev: ProgressEvent) => void;
  docOpts?: Record<string, unknown>;
}

export interface ParseStats {
  pages: number;
  words: number;
  lines: number;
  headings: number;
  tables: number;
  lists: number;
  codeBlocks: number;
  /** pages that had no text layer and were OCR'd */
  ocrPages: number;
  /** OCR attempts that failed (e.g. OCR engine unavailable offline) */
  ocrFailed: number;
  /** scanned pages left without text (OCR off, capped, or failed) */
  scannedUnread: number;
  /** Pages whose source visuals could not be rendered. */
  visualFailed: number;
  vectorFigures: number;
  vectorFailed: number;
  /** Figures that could not be drawn and have no data or relationship fallback. */
  vectorUnrepresented: number;
  /** Embedded raster regions with readable OCR text. */
  imageOcrRegions: number;
  /** Pages where embedded-image OCR could not run to completion. */
  imageOcrFailed: number;
  /** vector figure classification (not a pixel-preservation guarantee) */
  figures: number;
  /** structured form blocks (form_grid / form_matrix / worksheet / kv_panel / rail) */
  forms: number;
  chars: number;
  ms: number;
  extractMs: number;
  layoutMs: number;
  markdownMs: number;
}

export interface ProgressEvent {
  stage: 'extract' | 'layout' | 'markdown' | 'ocr' | 'image-ocr' | 'visuals' | 'video-analysis' | 'video-export' | 'done';
  mediaDone?: number;
  mediaTotal?: number;
  page?: number;
  pages?: number;
  ocrDone?: number;
  ocrTotal?: number;
  stats?: ParseStats;
}

export interface ParseOpts {
  /** Use rag to emit retrieval chunks with section headings and PDF source references. Default: faithful. */
  markdownProfile?: 'faithful' | 'rag';
  /** Rebuild detected vector figures as standalone SVG assets in Node. */
  vectorFigures?: boolean;
  /** Omit raster region assets; independent of preservePages. */
  skipRasterFigures?: boolean;
  /** Include richMarkdown with HTML table spans, and formHtml with labeled controls. */
  semanticHtml?: boolean;
  dropHeadersFooters?: boolean;
  /** Exclude text explicitly marked /Artifact. Off by default because some PDFs mistag data. */
  dropArtifacts?: boolean;
  detectBorderlessTables?: boolean;
  cache?: boolean;
  vision?: boolean;
  /** auto-OCR image-only (scanned) pages; default true */
  ocr?: boolean;
  /** tesseract language string; default 'vie+eng' */
  ocrLangs?: string | readonly string[];
  /** max pages to OCR per parse (safety valve); default Infinity */
  ocrPageLimit?: number;
  /** reconstruct chart/schematic/diagram regions as Mermaid/data tables; default true */
  figures?: boolean;
  /** per-page OCR JSON cache dir, Node only — interrupted scans resume from disk */
  ocrCacheDir?: string | null;
  /** No images by default; preservePages or vectorFigures opts into refs unless overridden. */
  imageMode?: 'refs' | 'base64' | 'none';
  /** Include a full-page visual reference for each page. Default false. */
  preservePages?: boolean;
  /** probe first scan page for Vietnamese: eng-only OCR when non-Vietnamese (~1.5-2x faster); explicit ocrLangs wins */
  ocrAutoLang?: boolean;
  /** recognize only the low-res content bbox (skip blank margins); default true */
  ocrRoi?: boolean;
  /** Also OCR and reconstruct supported embedded raster images. Default true. */
  ocrImages?: boolean;
  /** Optional browser Tesseract module and asset URLs. */
  ocrRuntime?: { module?: string; workerPath?: string; corePath?: string; langPath?: string; gzip?: boolean };
  /** document-wide cap on figure reconstructions; default Infinity */
  maxFigures?: number;
  onProgress?: (ev: ProgressEvent) => void;
  /** passed through to pdf.js getDocument (e.g. standardFontDataUrl, cMapUrl) */
  docOpts?: Record<string, unknown>;
}

export interface VisualContent {
  nodes?: string[];
  links?: { a: number; b: number; directed: boolean }[];
  labels?: string[];
}

export interface DetectedFigure {
  type: 'figure';
  page: number;
  reconstruction: 'geometry' | 'circuit-partial' | 'relations' | 'heuristic' | 'labels' | 'none';
  visualContent?: VisualContent;
  /** Bounding box in PDF points, top-left origin. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  kind: string;
  kind2?: string | null;
  mermaid?: string | null;
  svg?: string | null;
  tableMd?: string | null;
  data?: Record<string, unknown> | null;
}

export interface ParseResult {
  controls: PdfControl[];
  richMarkdown?: string;
  formHtml?: string;
  markdown: string;
  ragChunks?: RagChunk[];
  blocks: Block[];
  /** Detected vector figure regions; heuristic metadata, not a pixel-preservation guarantee. */
  figures: DetectedFigure[];
  pages: Block[][];
  documentGraph: DocumentGraph;
  /** Original PDF visual regions and optional full-page renders. */
  assets: PdfAsset[];
  imageMode: 'refs' | 'base64' | 'none';
  stats: ParseStats;
  caps: Caps;
  route: Route;
  version: string;
  fromCache: boolean;
  cacheBackend: 'opfs' | 'memory' | 'off';
}

export interface InitOpts {
  pdfjs?: unknown;
  docOpts?: Record<string, unknown>;
}

export class IngestLab {
  caps: Caps;
  route: Route;
  static init(opts?: InitOpts): Promise<IngestLab>;
  /** PDF -> markdown (vector-first). Works in Node too. */
  parse(bytes: Uint8Array | ArrayBuffer, opts?: ParseOpts): Promise<ParseResult>;
  /** Ingest a PDF, image, or video. Video keyframes require browser media APIs. */
  ingest(fileOrBlob: File | Blob | Uint8Array | ArrayBuffer, opts?: IngestOpts): Promise<IngestResult>;
}

export function detectCapabilities(): Promise<{ caps: Caps; route: Route }>;

// vision tier (experimental)
export function iou(a: [number, number, number, number], b: [number, number, number, number]): number;
export function nms<T extends { box: [number, number, number, number]; score: number }>(
  candidates: T[],
  thr?: number
): T[];
export function mergeRegions(
  blocks: Block[],
  regions: { cls: string; box: [number, number, number, number]; score: number }[],
  labelMap?: Record<string, unknown>
): Block[];
export interface VisionEngine {
  detect(canvas: HTMLCanvasElement): Promise<{ cls: string; score: number; box: [number, number, number, number] }[]>;
  labels: string[];
  inputSize: number;
}
export function createVisionEngine(opts: {
  modelUrl: string;
  labels: string[];
  inputSize?: number;
  scoreThreshold?: number;
  providers?: string[];
}): Promise<VisionEngine>;

// ---- video engine (src/video.js, src/keyframes.js, src/demux.js) ----
export const VIDEO_DEFAULTS: {
  sceneThreshold: number;
  maxKeyframes: null;
  contextIntervalUs: number;
  minGapUs: number;
  keyframeMaxWidth: number;
  webpQuality: number;
  usdPerFrameCloud: number;
  /** Minimum temporal sampling interval (µs); default 125000. */
  collectGapUs: number;
  /** Target upper bound on sampled frames; default 3600. */
  collectMaxFrames: number;
};
export function histogram2dFromImageData(data: Uint8ClampedArray | number[]): Float64Array;
export function normalize(hist: ArrayLike<number>): Float64Array;
export function bhattacharyyaDistance(p: ArrayLike<number>, q: ArrayLike<number>): number;
export function diffSeries(histograms: ArrayLike<number>[]): Float64Array;
export interface SelectedKeyframe {
  index: number;
  timestampUs: number;
  diffScore: number;
  isSceneCut: boolean;
}
export function selectKeyframes(
  timestampsUs: number[],
  diffs: ArrayLike<number>,
  opts?: { sceneThreshold?: number; maxKeyframes?: number; minGapUs?: number; fillThreshold?: number }
): SelectedKeyframe[];
export interface DemuxedVideo {
  container: 'mp4' | 'webm';
  codec: string;
  description?: Uint8Array;
  codedWidth: number;
  codedHeight: number;
  durationUs: number;
  chunks: { type: 'key' | 'delta'; timestampUs: number; durationUs: number; data: Uint8Array }[];
}
export function sniffKind(bytes: Uint8Array | ArrayBuffer): string;
export function demuxVideo(bytes: Uint8Array | ArrayBuffer): DemuxedVideo;
export function analyzeVideo(
  bytes: Uint8Array | ArrayBuffer,
  opts?: IngestOpts
): Promise<{
  keyframes: (Keyframe & { sceneId: number; reason: 'scene' | 'context'; blob: Blob })[];
  framesProcessed: number;
  width: number;
  height: number;
  durationUs: number;
  backend: 'webgpu-webcodecs' | 'webcodecs-2d' | 'rvfc-webgpu' | 'rvfc-2d' | 'seek-2d';
  sceneCuts: number;
  scenes: VideoScene[];
  scenesRepresented: number;
  maxFrameGapUs: number;
  /** true when the WebCodecs attempt failed and an element bridge was used */
  decodeRetried: boolean;
}>;

/** Destroy the cached GPUDevice (full teardown between heavy sessions). */
export function destroyVideoEngine(): boolean;

// ---- widget (ingestlab/widget, src/widget.js) ----
export interface IngestDropzoneElement extends HTMLElement {
  ingestFile(fileOrBlob: File | Blob): Promise<void>;
  readonly result: IngestResult | null;
}
export interface IngestDropzoneProps {
  label?: string;
  accept?: string;
  /** PDF Markdown output profile used by the browser widget. */
  markdownProfile?: 'faithful' | 'rag';
  sceneThreshold?: number;
  maxKeyframes?: number;
  pdfjsSrc?: string;
  pdfjsStdfonts?: string;
  demo?: boolean;
  onIngestResult?: (ev: CustomEvent<IngestResult>) => void;
  onIngestError?: (ev: CustomEvent<unknown>) => void;
  onIngestProgress?: (ev: CustomEvent<ProgressEvent>) => void;
  /** fired when the widget's bundled-sample button is clicked (attribute `demo` set) */
  onIngestSample?: (ev: CustomEvent<void>) => void;
  /** pass a React build explicitly; falls back to globalThis.React */
  react?: unknown;
  [key: string]: unknown;
}
export function IngestDropzone(props: IngestDropzoneProps): unknown;
