// TypeScript smoke test for types/index.d.ts — exercises the public surface
// the way a consumer would. `npm run types:check` (tsc -p test/tsconfig.json)
// must pass with ZERO errors in strict mode.
import type {
  IngestLab,
  IngestResult,
  IngestMetrics,
  Keyframe,
  ParseResult,
  Caps,
  Route,
  Block,
  ProgressEvent,
  IngestDropzoneElement,
  IngestDropzoneProps,
} from '../types/index.js';

export async function smoke(lab: IngestLab, blob: Blob): Promise<void> {
  // --- parse(): PDF -> markdown
  const parsed: ParseResult = await lab.parse(new Uint8Array(8), {
    onProgress: (ev: ProgressEvent) => {
      const stage: ProgressEvent['stage'] = ev.stage;
      void stage;
    },
    dropHeadersFooters: true,
    docOpts: { isEvalSupported: false },
  });
  const md: string = parsed.markdown;
  const tables: number = parsed.stats.tables;
  const block: Block = parsed.blocks[0];
  void md;
  void tables;
  void block.type;
  const caps: Caps = lab.caps;
  const route: Route = lab.route;
  void caps.wasmSimd;
  void route.video;

  // --- ingest(): unified entry, exactly the 7 spec metrics
  const res: IngestResult = await lab.ingest(blob, {
    sceneThreshold: 0.12,
    maxKeyframes: 8,
    minGapUs: 600000,
    fillThreshold: 0.12,
    usdPerFrameCloud: 0.0008,
    usdPerPageCloud: 0.003,
    onProgress: (ev) => void ev,
  });
  const m: IngestMetrics = res.metrics;
  const seven: readonly [string, number, number, number, number, number, boolean] = [
    m.backend,
    m.latencyMs,
    m.originalBytes,
    m.outputBytes,
    m.compressionRatio,
    m.estimatedSavedUsd,
    m.cacheHit,
  ];
  void seven;
  const kf: Keyframe | undefined = res.keyframes?.[0];
  const tsSec: number = kf?.timestamp ?? 0;
  const blobSize: number = kf?.blob?.size ?? 0;
  void tsSec;
  void blobSize;

  // --- widget element + React wrapper props (incl. the demo-sample event)
  const el = null as unknown as IngestDropzoneElement;
  await el.ingestFile(blob);
  const cached: boolean | undefined = el.result?.metrics.cacheHit;
  void cached;
  const props: IngestDropzoneProps = {
    label: 'Drop files',
    sceneThreshold: 0.12,
    maxKeyframes: 8,
    pdfjsSrc: 'https://example.invalid/pdf.min.mjs',
    pdfjsStdfonts: 'https://example.invalid/fonts/',
    demo: true,
    onIngestResult: (e) => e.detail.metrics.backend,
    onIngestError: (e) => void e,
    onIngestProgress: (e) => void e.detail.stage,
    onIngestSample: (e) => void e.detail,
  };
  void props;
}
import { IngestDropzoneElement as DropzoneConstructor, renderMarkdown } from 'ingestlab/widget';
import { IngestLab as PublishedIngestLab } from 'ingestlab';

const publishedInit: typeof PublishedIngestLab.init = PublishedIngestLab.init;
void publishedInit;
void DropzoneConstructor;
renderMarkdown('');
