// End-to-end Node test suite for INGESTLAB v0.2.0.
//  - PDF vector-first pipeline (unchanged from v0.1, must stay green)
//  - zero-dependency demuxers (MP4 + WebM) against real ffmpeg-generated fixtures
//  - scene math: histogram, Bhattacharyya, keyframe selection (pure)
//  - unified ingest() API: PDF path + metrics + cache (video needs a browser -> clear error)
// Run: npm test

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { IngestLab, detectCapabilities, iou, nms, mergeRegions } from '../src/index.js';
import {
  sniffKind,
  demuxVideo,
} from '../src/demux.js';
import {
  normalize,
  bhattacharyyaDistance,
  diffSeries,
  selectKeyframes,
} from '../src/keyframes.js';
import { histogram2dFromImageData } from '../src/video.js';
import { rgbToHex, grayToHex, cmykToHex, fitArc, detectPrimitives, contentItems } from '../src/pdfio.js';
import { partitionComponents, detectRuledTables, detectSemiRuledTables, joinCellText } from '../src/tables.js';
import { emitBlocks, applyImageMode } from '../src/markdown.js';
import { detectRuledLines } from '../src/ocr.js';
import '../src/widget.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const bytesOf = (p) => new Uint8Array(readFileSync(join(HERE, '..', 'samples', p)));
const PDF_FIXTURES = process.env.INGESTLAB_PDF_DIR || join(HERE, '..', '..', 'pdf');
const pdfBytes = bytesOf('sample.pdf');
assert.deepEqual(contentItems([
  { str: 'Body' }, { type: 'beginMarkedContentProps', tag: 'Artifact' },
  { type: 'beginMarkedContent', tag: 'Span' }, { str: 'Running header' },
  { type: 'endMarkedContent' }, { str: 'Page number' }, { type: 'endMarkedContent' }, { str: 'More body' },
]).map(({ str }) => str), ['Body', 'More body']);
const mp4Bytes = bytesOf('sample.mp4');
const webmBytes = bytesOf('sample.webm');
const sample3Bytes = bytesOf('sample3.mp4');

// Vision utilities
assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
assert.ok(iou([0, 0, 10, 10], [5, 0, 10, 10]) - 0.5 < 1e-9);
const kept = nms([
  { box: [0, 0, 10, 10], score: 0.9, cls: 'table' },
  { box: [1, 1, 10, 10], score: 0.8, cls: 'table' },
  { box: [50, 50, 10, 10], score: 0.7, cls: 'title' },
]);
assert.equal(kept.length, 2);
const merged = mergeRegions(
  [{ type: 'paragraph', text: 'x', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }],
  [{ cls: 'table', box: [0, 0, 12, 12], score: 0.9 }]
);
assert.equal(merged[0].type, 'table');
console.log('vision unit tests: OK');

// Scene scoring
// histogram: uniform mid-gray lands in bin 32
const gray = new Uint8ClampedArray(4 * 100);
for (let i = 0; i < 100; i++) {
  gray[i * 4] = 128;
  gray[i * 4 + 1] = 128;
  gray[i * 4 + 2] = 128;
}
const gHist = histogram2dFromImageData(gray);
let gMax = 0;
let gBin = -1;
gHist.forEach((v, i) => {
  if (v > gMax) {
    gMax = v;
    gBin = i;
  }
});
assert.equal(gBin, 32, `uniform gray -> bin 32 (got ${gBin})`);
assert.equal(gMax, 100, 'all pixels binned');

// Bhattacharyya: identical -> 0; disjoint -> 1; symmetric
const a = normalize([10, 10, 10, 10]);
const b = normalize([10, 10, 10, 10]);
const c = normalize([40, 0, 0, 0]);
const d = normalize([0, 0, 0, 40]);
assert.equal(bhattacharyyaDistance(a, b), 0, 'identical dists');
assert.ok(Math.abs(bhattacharyyaDistance(c, d) - 1) < 1e-9, 'disjoint dists -> 1');
assert.equal(bhattacharyyaDistance(c, d), bhattacharyyaDistance(d, c), 'symmetry');
assert.ok(bhattacharyyaDistance(a, c) > 0 && bhattacharyyaDistance(a, c) < 1, 'partial overlap in (0,1)');

// keyframe selection: 60 frames, hard cut at #30, spike mid-scene-2
const N = 60;
const ts = Array.from({ length: N }, (_, i) => i * 66667);
const histosSame = Array.from({ length: N }, () => normalize([5, 8, 12, 20, 30, 25, 15, 9]));
for (let i = 30; i < N; i++) histosSame[i] = normalize([30, 5, 2, 3, 2, 5, 6, 20]);
histosSame[45] = normalize([4, 30, 2, 5, 3, 4, 15, 10]); // spike mid-scene-2
const diffs = diffSeries(histosSame);
assert.ok(diffs[30] > 0.2, `scene cut diff high (${diffs[30].toFixed(3)})`);
assert.ok(diffs[1] < 0.02 && diffs[29] < 0.02, 'intra-scene diffs ~0');
const sel = selectKeyframes(ts, diffs, { sceneThreshold: 0.12, maxKeyframes: 6, minGapUs: 600000 });
assert.equal(sel[0].index, 0, 'first frame always included');
assert.ok(sel.some((s) => s.index === 30 && s.isSceneCut), 'cut at #30 flagged');
assert.ok(sel.length <= 6, 'maxKeyframes respected');
const chosenTs = sel.map((s) => s.timestampUs);
for (let i = 1; i < chosenTs.length; i++) {
  assert.ok(chosenTs[i] - chosenTs[i - 1] >= 600000 - 1e-6, 'min gap between keyframes');
}
const sel1 = selectKeyframes(ts, diffs, { sceneThreshold: 0.99, maxKeyframes: 8, minGapUs: 0 });
assert.equal(sel1[0].index, 0, 'threshold above all diffs -> still returns first frame');
// fill discipline: every non-first keyframe must carry a diff >= sceneThreshold
for (const s of sel) {
  assert.ok(s.index === 0 || s.diffScore >= 0.12, `keyframe #${s.index} justifies itself (d=${s.diffScore.toFixed(3)})`);
}
// fillThreshold: 0 restores the old fill-everything behavior
const selFill = selectKeyframes(ts, diffs, { sceneThreshold: 0.12, maxKeyframes: 6, minGapUs: 0, fillThreshold: 0 });
assert.ok(selFill.length > sel.length, 'fillThreshold=0 fills remaining slots again');
console.log('scene math unit tests: OK');

// Demuxers
assert.equal(sniffKind(pdfBytes), 'pdf');
assert.equal(sniffKind(mp4Bytes), 'video/mp4');
assert.equal(sniffKind(webmBytes), 'video/webm');

for (const [name, bytes, expect] of [
  ['sample.mp4', mp4Bytes, { container: 'mp4', codecPrefix: 'avc1.', frames: 66, minKeys: 3, durMin: 4e6, durMax: 4.8e6 }],
  ['sample.webm', webmBytes, { container: 'webm', codecPrefix: 'vp09', frames: 66, minKeys: 1, durMin: 4e6, durMax: 4.8e6 }],
  ['sample3.mp4', sample3Bytes, { container: 'mp4', codecPrefix: 'avc1.', frames: 90, minKeys: 1, durMin: 5.5e6, durMax: 6.6e6 }],
]) {
  const v = demuxVideo(bytes);
  assert.equal(v.container, expect.container, `${name} container`);
  assert.ok(v.codec.startsWith(expect.codecPrefix), `${name} codec ${v.codec}`);
  assert.equal(v.codedWidth, 320, `${name} width`);
  assert.equal(v.codedHeight, 180, `${name} height`);
  assert.equal(v.chunks.length, expect.frames, `${name} frame count`);
  const keys = v.chunks.filter((c) => c.type === 'key').length;
  assert.ok(keys >= expect.minKeys, `${name} has keyframes (${keys})`);
  assert.ok(v.chunks.every((c) => c.data.length > 0), `${name} chunks non-empty`);
  const mono = v.chunks.every((c, i) => i === 0 || c.timestampUs >= v.chunks[i - 1].timestampUs);
  assert.ok(mono, `${name} timestamps monotonic`);
  const dur = v.chunks[v.chunks.length - 1].timestampUs;
  assert.ok(dur > expect.durMin && dur < expect.durMax, `${name} duration (${dur}us)`);
  console.log(`demux ${name}: ${v.chunks.length} chunks, ${keys} keyframes, codec ${v.codec} — OK`);
}
// sample3 = 3 scenes of 2s. x264 (scenecut on) places IDRs only at scene starts
// (0s, 2s, 4s) — no per-second IDR noise like a naive -g 15 fixture would have.
{
  const v3 = demuxVideo(sample3Bytes);
  const keyTs = v3.chunks.filter((c) => c.type === 'key').map((c) => c.timestampUs / 1e6);
  assert.ok(keyTs.length >= 1 && keyTs.length <= 3, `sample3 IDRs only at scene starts (got ${keyTs.length}: ${keyTs})`);
  for (const t of keyTs) {
    assert.ok(
      [0, 2, 4].some((s) => Math.abs(t - s) < 0.06),
      `sample3 keyframe at ${t}s must coincide with a scene start`
    );
  }
  assert.ok(keyTs[0] === 0, 'sample3 starts with a keyframe');
  assert.ok(v3.chunks.some((c) => c.timestampUs / 1e6 > 5.9), 'sample3 reaches the third scene');
}
assert.throws(() => demuxVideo(pdfBytes), /unsupported container/, 'pdf into demux -> clean error');

// Backend selection
const { caps, route } = await detectCapabilities();
console.log(
  'capabilities:',
  JSON.stringify({ ...caps, gpuAdapter: undefined }),
  '-> route',
  JSON.stringify(route)
);

// PDF parsing regressions
const t0 = performance.now();
const lab = await IngestLab.init();
const doc = await lab.parse(pdfBytes, { cache: false });
const initParseMs = Math.round((performance.now() - t0) * 10) / 10;

console.log('---- markdown ----');
console.log(doc.markdown);
console.log('---- stats ----');
console.log(JSON.stringify(doc.stats, null, 2));

const md = doc.markdown;
assert.ok(md.includes('# Quarterly Infrastructure Report'), 'H1 title');
assert.ok(md.includes('## 1. Executive Summary'), 'H2 exec summary');
assert.ok(md.includes('## 2. Methodology'), 'H2 methodology');
assert.equal(doc.stats.headings, 3, 'exactly 3 headings');
assert.ok(md.includes('| Region | Requests | p99 (ms) |'), 'table header row');
assert.ok(md.includes('| --- | --- | --- |'), 'table separator');
const euRow = md.split('| EU West | 1,204,880 | 38 |').length - 1;
assert.equal(euRow, 2, 'EU West row present in ruled AND borderless table');
assert.ok(md.includes('| US East | 2,911,455 | 41 |'), 'US East row');
assert.equal(doc.stats.tables, 2, 'two tables detected');
assert.ok(md.includes('performance layer'), 'hyphenated word rejoined');
assert.ok(!md.includes('perform- '), 'no leftover hyphen split');
assert.ok(!md.includes('perform-\nance'), 'no hyphen+newline split');
assert.ok(md.includes('- WebGPU path handles layout inference'), 'bullet list');
assert.ok(md.includes('- WASM SIMD fallback keeps parity'), 'bullet 2');
assert.ok(md.includes('1. Ship the vector-first extractor'), 'ordered list keeps number');
assert.ok(md.includes('2. Publish the timestamped benchmark suite'), 'ordered item 2');
assert.ok(md.includes('```'), 'code fences');
assert.ok(md.includes('const lab = await IngestLab.init();'), 'code line 1');
assert.ok(md.includes('console.log(doc.stats.words);'), 'code line 3');
assert.ok(!md.includes('INGESTLAB SAMPLE DOCUMENT'), 'repeated header dropped');
const barePageNum = md.split('\n').some((l) => l.trim() === '1' || l.trim() === '2');
assert.ok(!barePageNum, 'bare page numbers dropped');
assert.ok(md.includes('monthly invoice dropped by more than half'), 'paragraph merged');
assert.equal(doc.assets.length, 0, 'parser creates no image assets');
assert.ok(!/!\[[^\]]*\]\([^)]*\)/.test(md), 'parser output has no generated Markdown image references');
assert.ok(!/data:image\//i.test(md), 'parser output contains no embedded image pixels');

// PDF ingest
const ing = await lab.ingest(pdfBytes.slice(), { cache: false });
assert.equal(ing.kind, 'pdf', 'ingest kind sniffed');
assert.equal(ing.markdown, doc.markdown, 'ingest reuses parse output');
for (const k of ['backend', 'latencyMs', 'originalBytes', 'outputBytes', 'compressionRatio', 'estimatedSavedUsd', 'cacheHit']) {
  assert.ok(k in ing.metrics, `metric ${k} present`);
}
assert.equal(ing.metrics.originalBytes, pdfBytes.length, 'originalBytes');
assert.ok(ing.metrics.compressionRatio > 0, 'compressionRatio > 0');
assert.ok(ing.metrics.estimatedSavedUsd > 0, 'estimatedSavedUsd > 0 (2 pages)');
const ing2 = await lab.ingest(pdfBytes.slice(), { cache: true });
const ing3 = await lab.ingest(pdfBytes.slice(), { cache: true });
assert.equal(ing2.metrics.cacheHit, false, 'ingest first run is a miss');
assert.equal(ing3.metrics.cacheHit, true, 'ingest second run is a cache hit');
assert.equal(ing3.markdown, ing.markdown, 'cached markdown identical');
console.log('ingest() PDF path + metrics + cache: OK');

// Keep the public metrics object limited to its seven documented fields.
{
  const SPEC = ['backend', 'latencyMs', 'originalBytes', 'outputBytes', 'compressionRatio', 'estimatedSavedUsd', 'cacheHit'];
  const got = Object.keys(ing.metrics).sort();
  assert.deepEqual(got, [...SPEC].sort(), 'metrics = exactly the 7 spec fields');
  assert.ok(ing.metrics.compressionRatio > 1, `PDF->markdown compresses (x${ing.metrics.compressionRatio})`);
  // Corrupt image input gives an actionable decode error.
  const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);
  await assert.rejects(() => lab.ingest(pngMagic, { cache: false }), /could not decode the image/);
  console.log('ingest() envelope spec-compliance (7 metrics, image guard): OK');

// Edge-resolution fixtures demux
for (const [file, w, h] of [['edge-854x480.mp4', 854, 480], ['edge-portrait-360x640.mp4', 360, 640]]) {
  const d = demuxVideo(readFileSync(new URL(`../samples/${file}`, import.meta.url)));
  assert.equal(d.codedWidth, w, `${file} width`);
  assert.equal(d.codedHeight, h, `${file} height`);
  assert.ok(d.chunks.length > 0, `${file} has chunks`);
  assert.equal(d.chunks[0].type, 'key', `${file} starts on a keyframe`);
  console.log(`demux ${file}: ${d.codedWidth}x${d.codedHeight}, ${d.chunks.length} chunks — OK`);
}
}

// Video ingest without browser APIs
await assert.rejects(
  () => lab.ingest(mp4Bytes.slice(), { cache: false }),
  /neither WebCodecs nor a DOM/,
  'video ingest in Node -> clean error'
);

// widget module loads headlessly (customElements absent -> registration skipped)
console.log('widget module import: OK');

// GPU teardown hook is a safe no-op in Node (no WebGPU adapter)
const { destroyVideoEngine } = await import('../src/video.js');
assert.equal(destroyVideoEngine(), false, 'destroyVideoEngine() in Node -> false (no device)');
console.log('destroyVideoEngine() no-op in Node: OK');

// Adaptive scene detection + ranked fill
{
  const T = (arr) => Array.from({ length: arr.length }, (_, i) => i * 100000);
  // quiet real-world footage: noise floor ~0.02-0.04, one small hard cut 0.10
  const noise = [0, 0.021, 0.033, 0.019, 0.04, 0.028, 0.023, 0.031, 0.1, 0.024, 0.03, 0.026];
  const sel = selectKeyframes(T(noise), noise, { sceneThreshold: 0.12, maxKeyframes: 8, minGapUs: 100000 });
  const cut = sel.find((k) => k.isSceneCut);
  assert.ok(cut && cut.index === 8, `adaptive bar catches the quiet 0.10 cut (got ${JSON.stringify(sel)})`);
  // relaxed fill: noise peaks become keyframes when slots remain
  assert.ok(sel.length >= 2, 'relaxed fill adds representative keyframes on quiet footage');
  // a genuinely flat video still collapses to the first frame (nothing to show)
  const flat = selectKeyframes(T([0, 0.004, 0.006, 0.003, 0.005]), [0, 0.004, 0.006, 0.003, 0.005], { minGapUs: 100000 });
  assert.equal(flat.length, 1, 'flat footage -> first frame only');
  // explicit fillThreshold keeps the strict contract; 0 restores fill-all
  const strict = selectKeyframes(T(noise), noise, { sceneThreshold: 0.12, fillThreshold: 0.12, minGapUs: 100000 });
  assert.ok(
    strict.every((k, i) => i === 0 || k.isSceneCut || k.diffScore >= 0.12),
    'explicit fillThreshold keeps fills strict (cuts may sit below it via the adaptive bar)'
  );
  // synthetic 3-scene stays identical with adaptive on (cuts 0.9 >= bar cap)
  const three = [0, ...Array(29).fill(0.02), 0.906, ...Array(29).fill(0.015), 0.846, ...Array(29).fill(0.018)];
  const sel3 = selectKeyframes(T(three), three, { minGapUs: 100000 });
  assert.deepEqual(sel3.filter((k) => k.isSceneCut).map((k) => k.index), [30, 60], '3-scene fixture unchanged');
  console.log('adaptive scene detection + ranked fill: OK');
}

// Raster OCR rules feed the existing ruled-table engine
{
  const width = 600, height = 480;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x, y) => {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
    data[i + 3] = 255;
  };
  // 3 row rules × 3 column rules at the OCR render's 2x scale.
  for (const y of [100, 180, 260, 340]) for (let x = 100; x <= 500; x++) { ink(x, y); ink(x, y + 1); }
  for (const x of [100, 300, 500]) for (let y = 100; y <= 340; y++) { ink(x, y); ink(x + 1, y); }
  const segments = detectRuledLines({ data, w: width, h: height }, 300, 240);
  assert.ok(segments.h.length >= 3, `raster horizontal rules synthesized (${segments.h.length})`);
  assert.ok(segments.v.length >= 3, `raster vertical rules synthesized (${segments.v.length})`);
  assert.deepEqual(detectRuledLines({ data: data.filter((_, i) => i % 4 === 0),
    w: width, h: height, stride: 1 }, 300, 240), segments);
  const words = [
    { str: 'Description', x0: 60, x1: 110, y: 70, size: 8 },
    { str: 'Amount', x0: 160, x1: 190, y: 70, size: 8 },
    { str: 'Income', x0: 60, x1: 90, y: 110, size: 8 },
    { str: '1250', x0: 165, x1: 185, y: 110, size: 8 },
  ];
  const tables = detectRuledTables(words, segments, 300, 240);
  assert.ok(tables.length >= 1, 'synthesized raster rules reach ruled-table reconstruction');
  assert.ok(tables[0].rows.flat().some((cell) => cell.includes('1250')), 'OCR text assigned to the synthesized grid');
  console.log('raster OCR rule synthesis + table reconstruction: OK');
}

// Cell text: stable undivided columns, including staggered baselines
{
  const w = (str, x0, x1, y, size = 10) => ({ str, x0, x1, y, size });
  const words = [
    w('For', 100, 116, 100), w('the', 121, 139, 100), w('year', 144, 169, 100), w('Jan', 174, 194, 100), w('1-Dec', 199, 231, 100),
    w('See', 300, 322, 106), w('separate', 327, 371, 106), w('instructions', 376, 435, 106),
    w('enter', 100, 129, 120), w('amount', 134, 177, 120), w('from', 182, 210, 120), w('form', 215, 239, 120),
    w('attach', 300, 338, 126), w('schedule', 343, 390, 126), w('here', 395, 421, 126),
  ];
  assert.equal(
    joinCellText(words),
    'For the year Jan 1-Dec enter amount from form | See separate instructions attach schedule here',
    'repeatable whitespace gutter separates interleaved, baseline-offset header columns'
  );
  const prose = [w('A', 20, 27, 10), w('normal', 33, 66, 10), w('paragraph', 72, 124, 10), w('continues', 130, 179, 10)];
  assert.equal(joinCellText(prose), 'A normal paragraph continues', 'one-line prose is not split');
  console.log('staggered table-cell columns: OK');
}

// Column-band reading order + legal headings
{
  const { buildPageLayout, legalHeadingLevel } = await import('../src/layout.js');
  const W = 612, H = 792;
  const mk = (str, x0, y, size = 10) => ({
    words: str.split(' ').map((w, i) => ({ str: w, x0: x0 + i * 50, x1: x0 + i * 50 + 48, y, size, mono: false })),
    text: str, x0, x1: x0 + str.length * 5.2, y, size, mono: false,
  });
  // 2-column page: full-width title, left column text, right column text
  const lines = [
    mk('The Title of the Paper', 100, 60, 18),
    mk('LEFT first sentence one', 60, 120), mk('LEFT second sentence two', 60, 134), mk('LEFT third line here', 60, 148), mk('LEFT fourth line', 60, 162),
    mk('RIGHT first sentence one', 360, 120), mk('RIGHT second sentence two', 360, 134), mk('RIGHT third line here', 360, 148), mk('RIGHT fourth line', 360, 162),
  ];
  const blocks = buildPageLayout({ width: W, height: H, lines, segments: { h: [], v: [] }, words: lines.flatMap((l) => l.words) }, { body: 10, headingLevels: new Map([[18, 1]]) }, {});
  const texts = blocks.filter((b) => b.type === 'paragraph').map((b) => b.text).join('|');
  assert.ok(texts.includes('LEFT first|LEFT second') === false, 'left lines merged as a paragraph');
  const leftPos = texts.indexOf('LEFT third');
  const rightPos = texts.indexOf('RIGHT first');
  assert.ok(leftPos !== -1 && rightPos !== -1 && leftPos < rightPos, `left column read before right (${texts.slice(0, 120)})`);
  // Crop-free figure/image notes retain their position in the visual stream,
  // and rebuilding layout from the same page context must be repeatable.
  const { emitBlocks } = await import('../src/markdown.js');
  const VW = 612, VH = 792;
  const line = (text, x0, y) => ({
    text,
    x0,
    x1: x0 + text.length * 5,
    y,
    size: 10,
    mono: false,
    words: text.split(/\s+/).map((str, i) => ({ str, x0: x0 + i * 38, x1: x0 + i * 38 + 32, y, size: 10, mono: false })),
  });
  const visualFigure = {
    bbox: { x0: 80, y0: 142, x1: 260, y1: 188 },
    kind: 'diagram',
    mermaid: 'graph TD; A-->B;',
  };
  const page = {
    width: VW,
    height: VH,
    lines: [
      line('LEFT opening words line', 60, 100),
      line('LEFT second words line', 60, 125),
      line('LEFT third words line', 60, 205),
      line('LEFT fourth words line', 60, 235),
      line('RIGHT opening words line', 360, 100),
      line('RIGHT second words line', 360, 125),
      line('RIGHT third words line', 360, 205),
      line('RIGHT fourth words line', 360, 235),
    ],
    words: [],
    segments: { h: [], v: [] },
    figures: [visualFigure],
    images: [
      { x0: 100, y0: 150, x1: 180, y1: 170 }, // raster placement inside the figure bbox
      { x0: 3, y0: 74, x1: 8, y1: 81 }, // tiny image at the page margin
      { x0: 0, y0: 0, x1: VW, y1: VH }, // full-page scan placement
    ],
  };
  page.words = page.lines.flatMap((l) => l.words);
  const scale = { body: 10, headingLevels: new Map() };
  const first = buildPageLayout(page, scale);
  const second = buildPageLayout(page, scale);
  for (const blocks of [first, second]) {
    const md = emitBlocks(blocks);
    const leftStart = md.indexOf('LEFT opening');
    const figureStart = md.indexOf('graph TD; A-->B;');
    const leftAfter = md.indexOf('LEFT third');
    const imageNote = md.indexOf('[Image region 80×20]');
    const tinyImageNote = md.indexOf('[Image region 5×7]');
    const fullPageNote = md.indexOf('[Full-page image 612×792]');
    const rightAfter = md.indexOf('RIGHT third');
    assert.ok(leftStart < figureStart && figureStart < imageNote && imageNote < leftAfter,
      `diagram and embedded raster note stay in left-column reading order: ${md}`);
    assert.ok(leftAfter < rightAfter, `columns remain in left-to-right reading order: ${md}`);
    assert.ok(tinyImageNote >= 0 && fullPageNote >= 0, 'tiny margin and full-page image placements are each noted');
    assert.ok(!md.includes('[Image: diagram'), 'a Mermaid diagram does not need a redundant image placeholder');
    assert.ok(!/!\[[^\]]*\]\(/.test(md) && !/data:image\//i.test(md), 'crop-free figure and placement output contains no image elements or pixels');
  }
  assert.ok(first.some((b) => b.type === 'figure') && second.some((b) => b.type === 'figure'), 'repeated layout preserves figure blocks');
  console.log('crop-free visual notes + repeatable column order: OK');
  // legal headings
  assert.equal(legalHeadingLevel('Chương I. Quy định chung'), 2);
  assert.equal(legalHeadingLevel('Điều 5. Nguyên tắc'), 3);
  assert.equal(legalHeadingLevel('điều này được áp dụng'), 0);
  console.log('column-band order + legal headings: OK');
}

// Real-world PDF gate (upload/ files, no OCR)
{
  const { existsSync, readFileSync, readdirSync } = await import('node:fs');
  const UPLOAD = PDF_FIXTURES;
  if (existsSync(UPLOAD)) {
    const cases = [
      ['f1040 (1).pdf', (doc, md) => !md.includes('|  |  |  |  |  |  |  |  |  |  |  |') && md.includes('Filing')],
      ['1706.03762v7.pdf', (doc, md) => md.includes('Transformer') && !/[a-z\)] arXiv:1706/.test(md)],
      ['Luat dat dai - Luat31 2024 QH15.pdf', null], // scanned -> OCR gate runs in test:ocr
      ['Năm 2025_Báo cáo tài chính hợp nhất giữa niên độ soát xét.pdf', null], // scanned
      ['viet-nam-2025.pdf', (doc, md) => doc.stats.headings > 0],
      // Diodes datasheet is schematic-heavy: real quality win is NO false-positive
      // tables from figure boxes + clean text (tables gate is content-based)
      // band widening (v0.2.3) correctly drops the per-page running title
      // "LOW POWER DUAL OPERATIONAL AMPLIFIERS" — gate on stable content
      ['LM358 (1).pdf', (doc, md) => md.includes('Electrical Characteristics') && !md.includes('|  |  |  |  |  |  |  |  |  |  |  |')],
      ['p1040.pdf', (doc, md) => /Tax and Earned Income Credit/i.test(md)],
      ['lm358.pdf', (doc, md) => md.includes('Electrical Characteristics') && doc.stats.tables >= 1],
    ];
    const names = readdirSync(UPLOAD);
    let gated = 0;
    for (const [f, check] of cases) {
      const real = names.find((n) => n.normalize('NFC') === f.normalize('NFC'));
      if (!real) { console.log(`real-pdf gate: ${f} not present, skipped`); continue; }
      const doc = await lab.parse(new Uint8Array(readFileSync(`${UPLOAD}/${real}`)), { cache: false, ocr: false });
      assert.ok(doc.stats.pages > 0, `${f} parses`);
      if (check) { assert.ok(check(doc, doc.markdown), `${f} quality check`); gated++; }
    }
    console.log(`real-world PDF gate: OK (${gated} quality-checked, all parse clean)`);
  } else {
    console.log('real-world PDF fixtures not present, skipped');
  }
}

// Math blocks
{
  const { mathScore, toMathText } = await import('../src/math.js');
  const mk = (text, shifts) => ({
    text,
    size: 10,
    words: text.split(' ').map((t, i) => ({ str: t, x0: i * 60, x1: i * 60 + 50, y: 100 + (shifts[i] || 0), mono: false })),
  });
  const formula = mk('Attention(Q, K, V) = softmax(QK^T / \u221adk) V', {});
  assert.ok(mathScore(formula) >= 0.22, `formula scores >= 0.22 (got ${mathScore(formula).toFixed(3)})`);
  const prose = mk('In 2024 (the last full year), the model family grew quickly.', {});
  assert.ok(mathScore(prose) < 0.22, `prose stays below (got ${mathScore(prose).toFixed(3)})`);
  // superscript at y 92 vs baseline 100 (size 10) -> ^{...}
  const shifted = mk('x n 1 sum', [-8, 0, -8, 0]);
  const out = toMathText(shifted);
  assert.ok(out.includes('^{'), `baseline shifts become ^{} (got ${out})`);
  console.log('math detection + reconstruction: OK');
}

// Borderless end-alignment (2-col scorecard)
{
  const { findBorderlessTable } = await import('../src/tables.js');
  const mk = (parts, y) => ({
    x0: Math.min(...parts.map((p) => p[1])),
    x1: Math.max(...parts.map((p) => p[2])),
    y,
    size: 8,
    words: parts.map(([str, x0, x1]) => ({ str, x0, x1, y, mono: false })),
    text: parts.map((p) => p[0]).join(' '),
  });
  // scorecard: wrapped label, right-aligned numbers in 2 columns
  const lines = [
    mk([['Applicable fee schedule for', 60, 300]], 100),
    mk([['Environmental Clearances', 60, 250], ['1.67', 500, 521], ['1.67', 590, 611]], 112),
    mk([['Availability of EIA list', 60, 290], ['0.00', 500, 521], ['1.67', 590, 611]], 134),
  ];
  const bt = findBorderlessTable(lines);
  assert.ok(bt, 'end-alignment finds the 2-numeric-column scorecard');
  assert.equal(bt.rows.length, 2, 'label-only fragment merged into the numbers row');
  assert.ok(bt.rows[0][0].includes('Applicable') && bt.rows[0][0].includes('Clearances'), 'wrapped label joined');
  assert.equal(bt.rows[0][1], '1.67', 'numbers land in their own column');
  console.log('borderless end-alignment + fragment merge: OK');
}

// Figure regions
{
  const { findFigureRegions } = await import('../src/figures.js');
  // a schematic: 60 stroke points in a text-free area, top-right quadrant
  const W = 612, H = 792;
  const drawPts = [];
  for (let i = 0; i < 60; i++) drawPts.push(360 + (i % 10) * 6, 120 + Math.floor(i / 10) * 8);
  const words = Array.from({ length: 8 }, (_, i) => ({ str: 'w' + i, x0: 60 + i * 40, x1: 90 + i * 40, y: 700 }));
  const page = { width: W, height: H, words, drawPts, images: [] };
  const regions = findFigureRegions(page, [], {});
  assert.ok(regions.length === 1, `one figure region found (got ${regions.length})`);
  assert.ok(regions[0].x0 >= 350 && regions[0].y0 >= 110, 'region covers the stroke cluster');
  // text-dense area -> no region
  const dense = { width: W, height: H, words: Array.from({ length: 60 }, (_, i) => ({ str: 'word', x0: 360 + (i % 10) * 6, x1: 390 + (i % 10) * 6, y: 120 + Math.floor(i / 10) * 8 })), drawPts: [...drawPts], images: [] };
  assert.equal(findFigureRegions(dense, [], {}).length, 0, 'text-dense area is not a figure');
  console.log('figure region detection: OK');
}

// Presentation quality
{
  const { isMathLine } = await import('../src/math.js');
  const { groupLines } = await import('../src/layout.js');
  const { headingPlausible, numberedHeadingLevel } = await import('../src/layout.js');
  const { findBorderlessTable } = await import('../src/tables.js');
  const mk = (text, y, x0 = 60, size = 10) => {
    const words = [];
    let x = x0;
    for (const t of text.split(/\s+/)) {
      const w = Math.max(3, t.length * size * 0.5);
      words.push({ str: t, x0: x, x1: x + w, y, size, mono: false });
      x += w + size * 0.6;
    }
    return { x0, x1: x, y, size, words, text };
  };
  // citations and parentheticals stay prose
  assert.equal(isMathLine(mk('[38, 2, 9].', 100)), false, 'citation is not math');
  assert.equal(isMathLine(mk('(3.5 days).', 100)), false, 'parenthetical is not math');
  assert.equal(isMathLine(mk('Attention(Q, K, V) = softmax(QK^T / \u221adk) V', 100)), true, 'real formula is math');
  // kerned number fragments join; subscripts attach compactly
  const frac = groupLines([
    { str: '2', x0: 100, x1: 104, y: 100, size: 10, mono: false },
    { str: '.', x0: 104.5, x1: 106, y: 100, size: 10, mono: false },
    { str: '0', x0: 106.5, x1: 110, y: 100, size: 10, mono: false },
  ]);
  assert.equal(frac[0].text, '2.0', `kerned digits join (got ${JSON.stringify(frac[0].text)})`);
  const sub = groupLines([
    { str: 'd', x0: 100, x1: 106, y: 100, size: 10, mono: false },
    { str: 'k', x0: 106.5, x1: 110, y: 103.4, size: 7, mono: false },
  ]);
  assert.ok(sub[0].text.includes('d_k'), `subscript attaches (got ${JSON.stringify(sub[0].text)})`);
  // size-set copy that flows on is not a heading; real title is
  assert.equal(headingPlausible('Provided proper attribution is provided, Google hereby grants permission to'), false, 'running license copy is not a heading');
  assert.equal(headingPlausible('scholarly works.'), false, 'lowercase fragment is not a heading');
  assert.equal(headingPlausible('Abstract'), true, 'short section label is a heading');
  assert.equal(headingPlausible('Attention Is All You Need'), true, 'title is a heading');
  assert.equal(numberedHeadingLevel('3.1 Encoder and Decoder Stacks'), 3, 'numbered subsection detected');
  assert.equal(numberedHeadingLevel('6.2.1 Details here'), 4, 'nested subsection level 4');
  // justified prose must not fabricate a start-aligned "table"
  const prose = [
    mk('Most competitive neural sequence transduction models have an', 100),
    mk('encoder-decoder structure built from attention and feed-forward', 112),
    mk('layers that map an input sequence of symbols to output symbols.', 124),
  ];
  assert.equal(findBorderlessTable(prose), null, 'justified prose is not a borderless table');
  console.log('presentation quality gates: OK');
}

// V0.2.4 feature locks
{
  const { detectSemiRuledTables } = await import('../src/tables.js');
  const { normalizeGlyphs } = await import('../src/pdfio.js');
  const { trimFloatingText } = await import('../src/figures.js');
  // semi-ruled accounting statement: V dividers + top/bottom rules, no row
  // rules; a wrapped label line merges into its row, numbers stay aligned
  const w = (str, x0, x1, y, size = 8) => ({ str, x0, x1, y, size, mono: false });
  const words = [
    w('M\u00e3 s\u1ed1', 60, 96, 100), w('Ch\u1ec9 ti\u00eau', 110, 200, 100), w('Cu\u1ed1i k\u1ef3', 400, 470, 100), w('\u0110\u1ea7u n\u0103m', 480, 550, 100),
    w('100', 60, 78, 130), w('Ph\u1ea3i thu ng\u1eafn', 110, 220, 130), w('74.759.825', 400, 470, 130), w('61.986.103', 480, 550, 130),
    w('h\u1ea1n c\u1ee7a kh\u00e1ch', 110, 218, 142), w('h\u00e0ng', 110, 150, 154),
    w('200', 60, 78, 172), w('Ti\u1ec1n g\u1edfi ng\u1eafn h\u1ea1n', 110, 230, 172), w('(919.067)', 400, 470, 172), w('2.114.920', 480, 550, 172),
    w('300', 60, 78, 194), w('Ti\u1ec1n \u0111ang chuy\u1ec3n', 110, 226, 194), w('12.4', 400, 424, 194), w('9.8', 480, 500, 194),
    w('400', 60, 78, 216), w('\u0110\u1ea7u t\u01b0 t\u00e0i ch\u00ednh', 110, 224, 216), w('3.205.779', 400, 470, 216), w('3.005.779', 480, 550, 216),
    w('500', 60, 78, 238), w('T\u1ed3n k\u1ebf', 110, 170, 238), w('8.619.034', 400, 470, 238), w('7.014.396', 480, 550, 238),
  ];
  const segments = {
    h: [
      { kind: 'h', pos: 90, from: 50, to: 560 },
      { kind: 'h', pos: 112, from: 50, to: 560 },
      { kind: 'h', pos: 252, from: 50, to: 560 },
    ],
    v: [
      { kind: 'v', pos: 50, from: 90, to: 252 },
      { kind: 'v', pos: 100, from: 90, to: 252 },
      { kind: 'v', pos: 390, from: 90, to: 252 },
      { kind: 'v', pos: 475, from: 90, to: 252 },
      { kind: 'v', pos: 560, from: 90, to: 252 },
    ],
  };
  const semi = detectSemiRuledTables(words, segments, 612, 792);
  assert.ok(semi.length === 1, `semi-ruled statement found (got ${semi.length})`);
  const t = semi[0];
  assert.ok(t.rows.length >= 5, `rows built (${t.rows.length})`);
  const row100 = t.rows.find((r) => r[0] && r[0].trim().startsWith('100'));
  assert.ok(row100, 'row 100 exists');
  assert.ok(
    row100[1] && row100[1].includes('kh\u00e1ch') && row100[1].includes('h\u00e0ng'),
    `wrapped label merged into its row (got ${JSON.stringify(row100 && row100[1])})`
  );
  assert.ok(row100[2].includes('74.759.825'), `number aligned to its row (got ${JSON.stringify(row100)})`);
  // Symbol-font PUA glyphs recover to real characters
  assert.equal(normalizeGlyphs('0.01\uf06dF'), '0.01\u03bcF', 'Symbol mu recovered');
  assert.equal(normalizeGlyphs('T\uf0b1 5\uf0b0C'), 'T\u00b1 5\u00b0C', 'plus-minus + degree recovered');
  assert.equal(normalizeGlyphs('a\uf123b'), 'ab', 'unknown PUA dropped');
  // trimFloatingText shrinks the snapshot away from formulas floating beside
  // a drawing, while labels ON the ink stay inside
  const region = { x0: 100, y0: 100, x1: 400, y1: 400, kind: 'schematic', labels: [], rotatedLabels: [] };
  const drawPts = [];
  for (let i = 0; i < 200; i++) drawPts.push(120 + (i % 15) * 12, 130 + Math.floor(i / 15) * 12);
  const figLines = [
    { text: 'V_O = V_1 + V_2', x0: 120, x1: 230, y: 420, size: 10 },
    { text: 'Schematic note', x0: 110, x1: 210, y: 92, size: 10 },
  ];
  const trimmed = trimFloatingText(region, figLines, drawPts);
  assert.ok(trimmed.y1 < 410, `formula below excluded (y1=${Math.round(trimmed.y1)})`);
  assert.ok(trimmed.y0 > 95, `title above excluded (y0=${Math.round(trimmed.y0)})`);
  console.log('v0.2.4 feature locks: OK');
}

// Real-file feature gates
{
  const { existsSync, readFileSync, readdirSync } = await import('node:fs');
  const UPLOAD = PDF_FIXTURES;
  if (existsSync(UPLOAD)) {
    const names = readdirSync(UPLOAD);
    const pick = (frag) => names.find((n) => n.normalize('NFC').includes(frag));
    const lm = pick('LM358 (1)');
    if (lm) {
      const doc = await lab.parse(new Uint8Array(readFileSync(`${UPLOAD}/${lm}`)), { cache: false, ocr: false });
      assert.ok(doc.stats.figures >= 5, `LM358 schematics reconstructed (got ${doc.stats.figures})`);
      // v0.4: figures no longer consume text — every schematic formula flows
      // as a math block, so the count can only grow vs the snapshot era
      assert.ok((doc.markdown.match(/\n\$\$/g) || []).length / 2 >= 5, `LM358 formulas emitted (got ${(doc.markdown.match(/\n\$\$/g) || []).length / 2})`);
    }
    const ax = pick('1706');
    if (ax) {
      const doc = await lab.parse(new Uint8Array(readFileSync(`${UPLOAD}/${ax}`)), { cache: false, ocr: false });
      assert.ok(doc.stats.figures >= 1, `paper figure captured (got ${doc.stats.figures})`);
      assert.ok((doc.markdown.match(/\n\$\$/g) || []).length / 2 >= 5, `paper math blocks (got ${(doc.markdown.match(/\n\$\$/g) || []).length / 2})`);
    }
    const vn = pick('viet-nam');
    if (vn) {
      const doc = await lab.parse(new Uint8Array(readFileSync(`${UPLOAD}/${vn}`)), { cache: false, ocr: false });
      assert.ok(doc.stats.tables >= 5, `scorecard tables detected (got ${doc.stats.tables})`);
    }
    console.log('real-file feature gates (figures/math/tables): OK');
  }
}

// Rich vector layer (colors, arcs, primitives)
{
  // color normalization
  assert.equal(rgbToHex(1, 0, 0), '#ff0000', 'RGB red');
  assert.equal(rgbToHex(0.5, 1, 0), '#80ff00', 'RGB mix');
  assert.equal(grayToHex(0.25), '#404040', 'gray 25%');
  assert.equal(grayToHex([0.5]), '#808080', 'gray array form');
  assert.equal(cmykToHex(0, 0, 0, 1), '#000000', 'CMYK registration black');
  assert.equal(cmykToHex(1, 0, 0, 0), '#00ffff', 'CMYK cyan');
  assert.equal(cmykToHex(0, 0, 0, 0), '#ffffff', 'CMYK white');

  // arc fitting: full circle
  const circle = [];
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    circle.push(100 + 40 * Math.cos(t), 200 + 40 * Math.sin(t));
  }
  const c = fitArc(circle);
  assert.ok(c && c.isCircle, 'closed circle polyline fits as a circle');
  assert.ok(Math.abs(c.cx - 100) < 1 && Math.abs(c.cy - 200) < 1 && Math.abs(c.r - 40) < 1.5, `circle params (${c.cx.toFixed(1)}, ${c.cy.toFixed(1)}, r=${c.r.toFixed(1)})`);
  assert.ok(Math.abs(c.sweep - Math.PI * 2) < 0.05, `full sweep ~2π (got ${c.sweep.toFixed(2)})`);

  // quarter arc: start angle at 0, sweep ~π/2
  const arc = [];
  for (let i = 0; i <= 8; i++) {
    const t = (i / 8) * (Math.PI / 2);
    arc.push(100 + 40 * Math.cos(t), 200 + 40 * Math.sin(t));
  }
  const q = fitArc(arc);
  assert.ok(q && Math.abs(q.sweep - Math.PI / 2) < 0.12, `quarter arc sweep ~π/2 (got ${q ? q.sweep.toFixed(2) : 'null'})`);
  assert.ok(q && Math.abs(q.startAngle) < 0.05, `arc start angle ~0 (got ${q ? q.startAngle.toFixed(2) : 'null'})`);

  // axis-aligned ellipse falls back from the circle fit
  const ell = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    ell.push(100 + 60 * Math.cos(t), 200 + 22 * Math.sin(t));
  }
  const e = fitArc(ell);
  assert.ok(e && !e.isCircle && Math.abs(e.rx - 60) < 3 && Math.abs(e.ry - 22) < 3, `ellipse rx/ry (${e ? e.rx.toFixed(1) : 'x'}, ${e ? e.ry.toFixed(1) : 'y'})`);

  // non-arcs
  assert.equal(fitArc([0, 0, 10, 1, 20, 2, 30, 3, 40, 4, 50, 5]), null, 'collinear points -> null');
  assert.equal(fitArc([0, 0, 1, 1]), null, 'too few points -> null');

  // micro-primitives: checkbox (checked), comb cells, radio (checked), junction, arrow
  const prims = detectPrimitives({
    boxes: [
      { x0: 0, y0: 0, x1: 9, y1: 9 }, // checkbox, two diagonals cross inside
      { x0: 30, y0: 0, x1: 39, y1: 9 }, // comb cells...
      { x0: 39, y0: 0, x1: 48, y1: 9 },
      { x0: 48, y0: 0, x1: 57, y1: 9 },
      { x0: 200, y0: 50, x1: 209, y1: 59 }, // checkbox unchecked
    ],
    diags: [
      [2, 5, 4, 7], // midpoint (3,6)
      [4, 7, 8, 2], // midpoint (6,4.5) — both inside box 1
    ],
    fills: [
      { bbox: { x0: 44, y0: 44, x1: 50, y1: 50 }, fillColor: '#000000', isRect: false, isDot: true, pts: [] }, // radio dot + junction
      { bbox: { x0: 100, y0: 100, x1: 110, y1: 106 }, fillColor: '#000000', isRect: false, isDot: false, pts: [100, 100, 110, 103, 100, 106] }, // arrow head
    ],
    curves: [
      { pts: [], strokeColor: '#000000', fillColor: null, lineWidth: 1, dashed: false, isClosed: true, arcFit: { cx: 47, cy: 47, rx: 5, ry: 5, sweep: Math.PI * 2, isCircle: true } },
      { pts: [50, 103, 102, 103], strokeColor: '#000000', fillColor: null, lineWidth: 1, dashed: false, isClosed: false, arcFit: null },
    ],
  });
  const byType = (t) => prims.filter((p) => p.type === t);
  const cb = byType('checkbox');
  assert.equal(cb.length, 2, `two checkbox primitives (got ${cb.length})`);
  assert.equal(cb[0].checked, true, 'checkbox with 2 interior diagonals -> checked');
  assert.equal(cb[1].checked, false, 'bare square -> unchecked');
  const combs = byType('comb');
  assert.equal(combs.length, 1, `comb detected (got ${combs.length})`);
  assert.equal(combs[0].cellCount, 3, 'comb of 3 equal cells');
  assert.equal(combs[0].cells.length, 3, 'comb keeps cell rects');
  const radios = byType('radio');
  assert.equal(radios.length, 1, `radio primitive (got ${radios.length})`);
  assert.equal(radios[0].checked, true, 'radio with interior dot -> checked');
  const junctions = byType('junction');
  assert.equal(junctions.length, 1, 'tiny dot -> junction');
  assert.ok(Math.abs(junctions[0].x - 47) < 0.5 && Math.abs(junctions[0].y - 47) < 0.5, 'junction at dot center');
  const arrows = byType('arrow');
  assert.equal(arrows.length, 1, `arrow head (got ${arrows.length})`);
  assert.ok(Math.abs(arrows[0].tip.x - 110) < 0.5, 'arrow apex = vertex farthest from the others');
  assert.ok(arrows[0].tail && Math.abs(arrows[0].tail.x - 102) < 0.5, 'arrow tail = nearest stroke endpoint');
  assert.ok(Math.abs(Math.cos(arrows[0].angle) - 1) < 0.01, 'arrow angle points +x');

  console.log('PDF colors, curves, and vector primitives: OK');
}

// Table engine
{
  // 2D connected-component isolation: two disjoint grids stay separate
  const g1 = {
    h: [100, 130, 160].map((y) => ({ pos: y, from: 72, to: 200 })),
    v: [72, 136, 200].map((x) => ({ pos: x, from: 100, to: 160 })),
  };
  const g2 = {
    h: [100, 130, 160].map((y) => ({ pos: y, from: 300, to: 460 })),
    v: [300, 380, 460].map((x) => ({ pos: x, from: 100, to: 160 })),
  };
  const comps = partitionComponents({ h: [...g1.h, ...g2.h], v: [...g1.v, ...g2.v] }, 4);
  assert.equal(comps.length, 2, `side-by-side tables partition separately (got ${comps.length})`);
  assert.ok(comps[0].bbox.x1 <= 201 && comps[1].bbox.x0 >= 299, 'component bboxes disjoint');

  // merged header cell -> colspan 2 -> semantic HTML emission
  const ys = [100, 124, 148, 172];
  const xs = [72, 200, 328, 456];
  const segs = {
    h: ys.map((y) => ({ pos: y, from: 72, to: 456 })),
    v: [
      { pos: 72, from: 100, to: 172 },
      { pos: 200, from: 124, to: 172 }, // header divider missing -> "PIN" spans cols 0+1
      { pos: 328, from: 100, to: 172 },
      { pos: 456, from: 100, to: 172 },
    ],
  };
  const W = (str, x0, x1, y) => ({ str, x0, x1, y, size: 8, mono: false });
  const words = [
    W('PIN', 110, 140, 112), W('SOIC', 340, 390, 112),
    W('1', 90, 98, 136), W('LCCC', 210, 260, 136), W('A1', 340, 364, 136),
    W('2', 90, 98, 160), W('SOIC', 210, 260, 160), W('B2', 340, 364, 160),
  ];
  const tables = detectRuledTables(words, segs, 600, 800, {});
  assert.equal(tables.length, 1, `one ruled table (got ${tables.length})`);
  const t = tables[0];
  assert.deepEqual(t.rows[0], ['PIN', '', 'SOIC'], 'merged header keeps placeholder empty');
  assert.ok((t.spans || []).some((s) => s.r === 0 && s.c === 0 && s.colspan === 2), `colspan=2 recovered (${JSON.stringify(t.spans)})`);
  // v0.4: pure GFM — no HTML in markdown output ever; the merged header cell
  // keeps its text in the owner column, covered cells stay empty
  const md = emitBlocks([{ type: 'table', rows: t.rows, spans: t.spans, meta: t.meta }]);
  assert.ok(!md.includes('<table') && !md.includes('<td') && !md.includes('<span'), 'no HTML in table emission');
  assert.ok(md.startsWith('| PIN |  | SOIC |'), `merged header flattens to pipes (${JSON.stringify(md.split('\n')[0])})`);
  assert.ok(md.includes('| --- | --- | --- |'), 'GFM separator emitted');
  assert.ok(md.includes('| 1 | LCCC | A1 |'), 'body cells render');

  // plain grid without merges stays clean GFM
  const plain = emitBlocks([{ type: 'table', rows: [['A', 'B'], ['1', '2']] }]);
  assert.ok(plain.includes('| A | B |') && plain.includes('| --- | --- |'), 'no-merge table emits GFM');

  // whitespace-valley subdivision: wide unruled numeric band splits
  const vsegs = {
    h: [
      { pos: 100, from: 72, to: 420 },
      { pos: 260, from: 72, to: 420 },
    ],
    v: [
      { pos: 72, from: 100, to: 260 },
      { pos: 150, from: 100, to: 260 },
      { pos: 420, from: 100, to: 260 },
    ],
  };
  const vwords = [];
  for (let r = 0; r < 9; r++) {
    const y = 115 + r * 16;
    vwords.push(W('Wages', 78, 122, y));
    vwords.push(W('1,000', 158, 208, y));
    vwords.push(W('2,000', 340, 392, y));
  }
  const vt = detectSemiRuledTables(vwords, vsegs, 600, 800);
  assert.equal(vt.length, 1, `semi-ruled region detected (got ${vt.length})`);
  const row0 = vt[0].rows[1] || vt[0].rows[0];
  assert.ok(row0.some((c) => c.trim() === '1,000') && row0.some((c) => c.trim() === '2,000'), `valley split separated the numeric pair (${JSON.stringify(vt[0].rows[0])})`);
  assert.ok(vt[0].rows[0].length >= 4, `split adds a column (cols=${vt[0].rows[0].length})`);

  console.log('Table grids, spans, whitespace, and HTML rendering: OK');
}

// Form/worksheet engine
{
  const { groupLines, buildPageLayout } = await import('../src/layout.js');
  const W = (str, x0, x1, y, size = 10) => ({ str, x0, x1, y, size, mono: false });

  // worksheet: title + coded line items + dot leaders + amounts + double rule
  const words = [
    W('Interest', 60, 118, 100, 11), W('Income', 122, 180, 100, 11),
    W('1', 60, 66, 130), W('Wages,', 70, 108, 130), W('tips,', 112, 142, 130),
    W('other', 146, 176, 130), W('compensation', 180, 262, 130),
    W('..............', 268, 356, 130), W('42,000', 380, 430, 130),
    W('2a', 60, 76, 150), W('Tax-exempt', 80, 146, 150), W('interest', 150, 200, 150), W('100', 220, 244, 150),
    W('2b', 280, 296, 150), W('Taxable', 300, 350, 150), W('interest', 354, 404, 150), W('0', 420, 428, 150),
    W('3', 60, 66, 170), W('Unemployment', 70, 160, 170), W('compensation', 164, 254, 170),
    W('..............', 268, 356, 170), W('1,200', 380, 424, 170),
  ];
  const page = {
    width: 612,
    height: 792,
    words,
    segments: {
      h: [
        { pos: 172.5, from: 370, to: 434 },
        { pos: 175.5, from: 370, to: 434 },
      ],
      v: [],
    },
    fills: [],
    primitives: [],
    annotations: [],
    curves: [],
    images: [],
    drawPts: [],
    rotated: [],
    checkboxes: [],
  };
  const scale = { body: 10, headingLevels: new Map() };
  const blocks = buildPageLayout({ ...page, lines: groupLines(words) }, scale, {});
  const ws = blocks.find((b) => b.type === 'worksheet');
  assert.ok(ws, `worksheet block emitted (${blocks.map((b) => b.type).join(',')})`);
  assert.equal(ws.rows.length, 4, `2a/2b split into separate rows (got ${ws.rows.length})`);
  assert.equal(ws.rows[0].code, '1');
  assert.equal(ws.rows[0].amount, '42,000');
  assert.ok(ws.rows[0].label.includes('Wages'), 'label kept');
  assert.equal(ws.rows[1].code, '2a');
  assert.equal(ws.rows[2].code, '2b', `sub-column split (${ws.rows.map((r) => r.code).join(',')})`);
  assert.equal(ws.rows[3].underline, 'double', `total row double-underline (${ws.rows[3].underline})`);
  const wsMd = emitBlocks([ws]);
  assert.ok(!wsMd.includes('<div') && !wsMd.includes('il-'), 'worksheet is pure markdown, no HTML');
  assert.ok(wsMd.includes('| Code | Item | Amount |'), 'worksheet emits a pipe table');
  assert.ok(wsMd.includes('42,000'), 'amount kept');
  assert.ok(wsMd.includes('**1,200**'), 'double-underline total row bolded');

  // checkbox option stack -> form_matrix
  const cw = [...words];
  cw.push(W('Filing', 60, 96, 200, 11), W('Status', 100, 150, 200, 11));
  cw.push(W('Single', 78, 106, 212, 9));
  cw.push(W('Married', 78, 114, 224, 9), W('jointly', 118, 160, 224, 9));
  cw.push(W('Head', 78, 100, 236, 9), W('of', 104, 114, 236, 9), W('household', 118, 172, 236, 9));
  const page2 = {
    ...page,
    words: cw,
    primitives: [
      { type: 'checkbox', bbox: { x0: 60, y0: 203, x1: 69, y1: 212 }, checked: true },
      { type: 'checkbox', bbox: { x0: 60, y0: 215, x1: 69, y1: 224 }, checked: false },
      { type: 'checkbox', bbox: { x0: 60, y0: 227, x1: 69, y1: 236 }, checked: false },
    ],
  };
  const blocks2 = buildPageLayout({ ...page2, lines: groupLines(cw) }, scale, {});
  const mx = blocks2.find((b) => b.type === 'form_matrix');
  assert.ok(mx, `form_matrix emitted (${blocks2.map((b) => b.type).join(',')})`);
  assert.equal(mx.rows.length, 3, 'three bound options');
  assert.ok(mx.rows[0][0].startsWith('☑'), 'checked glyph inline');
  assert.ok(mx.rows[0][0].includes('Single'), 'label bound to control');
  assert.ok(emitBlocks([mx]).includes('[x] Single'), 'checked box becomes GFM [x] in table cell');

  // micro-labeled field boxes -> form_grid
  const fw = [
    W('Your', 200, 224, 290, 7), W('first', 228, 248, 290, 7), W('name', 252, 276, 290, 7),
    W('Anna', 206, 232, 310, 9),
    W('State', 360, 384, 290, 7),
    W('CA', 366, 380, 310, 9),
    W('ZIP', 420, 438, 290, 7),
    W('code', 442, 466, 290, 7),
    W('94103', 424, 460, 310, 9),
  ];
  const page3 = {
    ...page,
    words: fw,
    primitives: [],
    fills: [
      { bbox: { x0: 200, y0: 298, x1: 340, y1: 316 }, fillColor: '#f5f5f5', isRect: true, isDot: false, pts: [] },
      { bbox: { x0: 360, y0: 298, x1: 410, y1: 316 }, fillColor: '#f5f5f5', isRect: true, isDot: false, pts: [] },
      { bbox: { x0: 420, y0: 298, x1: 470, y1: 316 }, fillColor: '#f5f5f5', isRect: true, isDot: false, pts: [] },
    ],
  };
  const blocks3 = buildPageLayout({ ...page3, lines: groupLines(fw) }, scale, {});
  const fg = blocks3.find((b) => b.type === 'form_grid');
  assert.ok(fg, `form_grid emitted (${blocks3.map((b) => b.type).join(',')})`);
  assert.equal(fg.rows.length, 1, 'one visual field row');
  assert.equal(fg.rows[0].length, 3, 'three fields');
  assert.equal(fg.rows[0][0].value, 'Anna', 'field value captured');
  assert.ok(fg.rows[0][0].label.includes('name'), 'micro-label bound');
  const fgMd = emitBlocks([fg]);
  assert.ok(!fgMd.includes('<div') && !fgMd.includes('<span'), 'field grid is pure markdown, no HTML');
  assert.ok(fgMd.includes('**Your first name:** Anna'), 'field value rendered bold-label + plain value');
  assert.ok(fgMd.includes('**ZIP code:** 94103'), 'bound label and value on one line');
  assert.ok(!fgMd.includes('[Anna]'), 'no bracket placeholders around values');

  console.log('Worksheets, option groups, and field grids: OK');
}

// Figure classifiers + reconstructors
{
  const { analyzeFigure, classifyFigure } = await import('../src/figrecon.js');
  const { trimFloatingText } = await import('../src/figures.js');
  const L = (str, x0, x1, y, size = 8) => ({ str, x0, x1, y, size });

  // gauge: concentric arcs + center KPI
  const arc = (cx, cy, r, sweep, color) => ({
    pts: [], strokeColor: color, fillColor: null, lineWidth: 3, dashed: false, isClosed: false,
    arcFit: { cx, cy, r, rx: r, ry: r, startAngle: -Math.PI / 2, sweep, direction: 1, isCircle: false },
  });
  const gRegion = { x0: 0, y0: 0, x1: 200, y1: 160, kind: 'schematic', labels: [L('77', 92, 108, 78, 14)], rotatedLabels: [], rH: [], rV: [] };
  const gPage = { width: 200, height: 160, curves: [arc(100, 80, 60, 4.8, '#22c55e'), arc(100, 80, 45, 3.5, '#f59e0b')], fills: [], primitives: [] };
  assert.equal(classifyFigure(gPage, gRegion), 'gauge', 'concentric arcs -> gauge');
  const g = analyzeFigure(gPage, gRegion);
  assert.ok(g && g.svg.includes('<path'), 'gauge svg draws arcs');
  assert.ok(g.svg.includes('77'), 'center KPI number inside svg');
  assert.ok(g.tableMd.includes('Share'), 'gauge data table with percentages');

  // flowchart: 3 boxes + arrow -> mermaid flowchart TD
  const fRegion = {
    x0: 0, y0: 0, x1: 300, y1: 300, kind: 'diagram',
    labels: [L('Start', 30, 70, 50), L('Check', 30, 75, 150), L('End', 30, 60, 250), L('Yes', 60, 82, 100)],
    rotatedLabels: [],
    rH: [], rV: [{ pos: 50, from: 70, to: 130 }, { pos: 50, from: 170, to: 230 }],
  };
  const fPage = {
    width: 300, height: 300, curves: [],
    fills: [
      { bbox: { x0: 20, y0: 30, x1: 120, y1: 70 }, fillColor: '#eef', isRect: true, isDot: false, pts: [] },
      { bbox: { x0: 20, y0: 130, x1: 120, y1: 170 }, fillColor: '#eef', isRect: true, isDot: false, pts: [] },
      { bbox: { x0: 20, y0: 230, x1: 120, y1: 270 }, fillColor: '#eef', isRect: true, isDot: false, pts: [] },
    ],
    primitives: [{ type: 'arrow', tip: { x: 50, y: 130 }, tail: { x: 50, y: 70 }, angle: Math.PI / 2, dashed: false }],
  };
  assert.equal(classifyFigure(fPage, fRegion), 'flowchart', 'boxes+arrows -> flowchart');
  const f = analyzeFigure(fPage, fRegion);
  assert.ok(f && f.mermaid.includes('flowchart TD'), `mermaid flowchart (${f && f.mermaid.slice(0, 20)})`);
  assert.ok(f.mermaid.includes('N0 -->'), 'edges from real strokes');
  assert.ok(f.mermaid.includes('Yes'), 'edge label bound');

  // xy chart: axes + 5 ticks + bars -> svg + data table
  const cRegion = {
    x0: 0, y0: 0, x1: 260, y1: 200, kind: 'chart',
    labels: [
      L('0', 30, 44, 178), L('25', 24, 44, 138), L('50', 24, 44, 98), L('75', 24, 44, 58), L('100', 18, 44, 18),
      L('Q1', 66, 94, 196), L('Q2', 106, 134, 196), L('Q3', 146, 174, 196),
    ],
    rotatedLabels: [],
    rH: [{ pos: 180, from: 50, to: 250 }],
    rV: [{ pos: 50, from: 10, to: 180 }],
  };
  const cPage = {
    width: 260, height: 200, curves: [],
    fills: [
      { bbox: { x0: 70, y0: 120, x1: 94, y1: 180 }, fillColor: '#60a5fa', isRect: true, isDot: false, pts: [] },
      { bbox: { x0: 110, y0: 80, x1: 134, y1: 180 }, fillColor: '#60a5fa', isRect: true, isDot: false, pts: [] },
      { bbox: { x0: 150, y0: 100, x1: 174, y1: 180 }, fillColor: '#60a5fa', isRect: true, isDot: false, pts: [] },
    ],
    primitives: [],
  };
  assert.equal(classifyFigure(cPage, cRegion), 'chart', 'axes+ticks+bars -> chart');
  const c = analyzeFigure(cPage, cRegion);
  assert.ok(c && c.svg.includes('<rect'), 'chart svg draws bars');
  assert.ok(c.tableMd.includes('Q1') && c.tableMd.includes('Q2'), `chart data table (${c.tableMd.slice(0, 60)})`);
  assert.ok(/\d/.test(c.tableMd.split('Q1')[1] || ''), 'bar values calibrated from y ticks');

  // UML sequence: lifelines + messages -> mermaid sequenceDiagram
  const sRegion = {
    x0: 0, y0: 0, x1: 300, y1: 200, kind: 'diagram',
    labels: [L('Client', 10, 50, 15, 9), L('Server', 130, 170, 15, 9), L('DB', 260, 280, 15, 9), L('GET /data', 60, 120, 56), L('query', 170, 210, 86)],
    rotatedLabels: [],
    rV: [{ pos: 30, from: 30, to: 190 }, { pos: 150, from: 30, to: 190 }, { pos: 270, from: 30, to: 190 }],
    rH: [{ pos: 60, from: 30, to: 150 }, { pos: 90, from: 150, to: 270 }],
  };
  const sPage = { width: 300, height: 200, curves: [], fills: [], primitives: [] };
  assert.equal(classifyFigure(sPage, sRegion), 'uml', 'lifelines+messages -> uml');
  const s = analyzeFigure(sPage, sRegion);
  assert.ok(s && s.mermaid.includes('sequenceDiagram'), 'mermaid sequenceDiagram');
  assert.ok(s.mermaid.includes('P0->>P1'), 'message arrows between participants');

  // circuit: junctions + refs + values -> svg + netlist
  const eRegion = {
    x0: 0, y0: 0, x1: 240, y1: 160, kind: 'schematic',
    labels: [L('R1', 30, 50, 40), L('10K', 30, 54, 52), L('R2', 110, 130, 40), L('20K', 110, 134, 52)],
    rotatedLabels: [],
    rH: [{ pos: 60, from: 40, to: 120 }],
    rV: [],
  };
  const ePage = { width: 240, height: 160, curves: [], fills: [], primitives: [{ type: 'junction', x: 80, y: 60 }, { type: 'junction', x: 120, y: 60 }] };
  assert.equal(classifyFigure(ePage, eRegion), 'circuit', 'junctions+refs -> circuit');
  const e = analyzeFigure(ePage, eRegion);
  assert.ok(e && e.svg.includes('<circle'), 'junction dots in svg');
  assert.ok(e.tableMd.includes('R1') && e.tableMd.includes('10K'), 'netlist table binds ref+value');

  // photo regions have no vector reconstruction
  const pRegion = { x0: 0, y0: 0, x1: 200, y1: 150, kind: 'photo', labels: [], rotatedLabels: [], rH: [], rV: [] };
  assert.equal(analyzeFigure({ curves: [], fills: [], primitives: [] }, pRegion), null, 'photo -> snapshot only');

  // smart annotation expansion: a pin label 20pt outside the ink joins the crop
  const tRegion = { x0: 100, y0: 100, x1: 200, y1: 160 };
  const tDrawPts = [100, 100, 200, 100, 200, 100, 200, 160, 200, 160, 100, 160, 100, 160, 100, 100];
  const tLines = [
    { text: 'OUT1', x0: 205, x1: 230, y: 105, size: 8, words: [L('OUT1', 205, 230, 105)] },
    { text: 'A very long prose paragraph line that sits next to the drawing and should never attach', x0: 205, x1: 380, y: 150, size: 9, words: [L('prose', 205, 240, 150)] },
  ];
  const tBox = trimFloatingText(tRegion, tLines, tDrawPts, { segments: { h: [], v: [] } });
  assert.ok(tBox.x1 >= 230, `peripheral pin label captured (x1=${Math.round(tBox.x1)})`);
  assert.ok(tBox.x1 <= 245, `prose line not absorbed (x1=${Math.round(tBox.x1)})`);

  console.log('Figure classification, reconstruction, and bounds: OK');
}

// Widget renderer (mermaid / HTML passthrough / sanitize)
{
  const { renderMarkdown, sanitizeHtml } = await import('../src/widget.js');

  // mermaid fences become renderable placeholders (lazy v11 load in browser)
  const mmd = renderMarkdown('```mermaid\nflowchart TD\n  A --> B\n```');
  assert.ok(mmd.includes('class="mermaid"'), 'mermaid placeholder div');
  assert.ok(mmd.includes('data-code="flowchart TD'), 'diagram code carried for the shadow-root renderer');
  assert.ok(mmd.includes('<pre class="code">flowchart'), 'diagram source remains visible until Mermaid renders');

  // semantic HTML tables pass through with spans intact
  const html = renderMarkdown('<table class="il-table">\n<tr><td colspan="2">PIN</td><th scope="col">SOIC</th></tr>\n<tr class="il-total-row"><td>7</td><td>1200</td></tr>\n</table>');
  assert.ok(html.includes('colspan="2"'), 'colspan passthrough');
  assert.ok(html.includes('il-total-row'), 'total row class passthrough');

  // styled form components pass through
  const form = renderMarkdown('<div class="il-form il-worksheet">\n  <div class="il-worksheet-row"><span class="il-code">1a</span><span class="il-label">Wages</span><span class="il-dot-leader"></span><span class="il-amount">42,000</span></div>\n</div>');
  assert.ok(form.includes('il-worksheet-row') && form.includes('il-dot-leader'), 'form component passthrough');

  // sanitization: active content stripped from passed-through HTML and SVG
  const dirty = sanitizeHtml('<table class="il-table" onclick="p0wn()"><script>alert(1)</script><tr><td onmouseover="x()" href="javascript:evil()">A</td></tr></table>');
  assert.ok(!dirty.includes('script'), 'script tags stripped');
  assert.ok(!dirty.includes('onclick') && !dirty.includes('onmouseover'), 'on* handlers stripped');
  assert.ok(!dirty.includes('javascript:'), 'javascript: urls stripped');
  assert.ok(dirty.includes('<table class="il-table">'), 'benign attributes kept');
  const dirtySvg = sanitizeHtml('<svg viewBox="0 0 10 10"><script>alert(1)</script><circle r="4" onload="x()" fill="#f00"/></svg>');
  assert.ok(!dirtySvg.includes('<script'), 'svg script stripped');
  assert.ok(!dirtySvg.includes('onload'), 'svg onload stripped');
  assert.ok(dirtySvg.includes('<circle r="4" fill="#f00"/>'), 'svg geometry kept');
  const rendered = renderMarkdown(dirtySvg);
  assert.ok(rendered.includes('<circle'), 'svg passthrough via renderMarkdown');

  // GFM table path still works
  const notePreview = renderMarkdown('> [Image region 80×20]\n\n> [Image: diagram — visual details may not be represented in extracted text]');
  assert.ok(notePreview.includes('<blockquote>') && !notePreview.includes('<img'), 'crop-free visual notes render without image elements');

  const gfm = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(gfm.includes('<table>') && gfm.includes('<td>1</td>'), 'plain GFM table still renders');

  console.log('Mermaid and HTML preview: OK');
}

// Image output modes
// imageMode policy: canonical refs markdown -> base64-embedded / no-image
// variants for different consumers (libraries vs AI pipelines)
{
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]); // fake PNG bytes
  const assets = [{ path: 'images/p1-fig1.png', bytes: png }, { path: 'images/p2-img1.png', bytes: png }];
  const md = [
    '# Doc',
    '![figure: photo 490×111](images/p1-fig1.png)',
    '![chart export](images/p2-img1.png)',
    '![unknown](no-such.png)',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
  ].join('\n');

  // refs: canonical passthrough (default + explicit)
  assert.equal(applyImageMode(md, assets), md, 'refs default passthrough');
  assert.equal(applyImageMode(md, assets, 'refs'), md, 'refs explicit passthrough');
  assert.equal(applyImageMode(md, null, 'refs'), md, 'refs with no assets');

  // base64: known assets embedded, unknown/data refs untouched, text untouched
  const b64 = applyImageMode(md, assets, 'base64');
  const expect = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
  assert.ok(b64.includes(`![figure: photo 490×111](${expect})`), 'figure ref embedded as data URL');
  assert.ok(b64.includes(`![chart export](${expect})`), 'image ref embedded as data URL');
  assert.ok(b64.includes('![unknown](no-such.png)'), 'unknown path left as-is');
  assert.ok(b64.includes('graph TD; A-->B;'), 'mermaid fence survives');

  // none: raster images -> text notes, alt preserved, code blocks untouched
  const none = applyImageMode(md, assets, 'none');
  assert.ok(none.includes('> [figure: photo 490×111]'), 'figure note keeps engine placeholder shape');
  assert.ok(none.includes('[image: chart export]'), 'plain image note');
  assert.ok(none.includes('[image: unknown]'), 'unknown ref stripped by shape — none-mode needs no asset lookup');
  assert.ok(!/!\[[^\]]*\]\(images\//.test(none), 'no asset-file refs remain');
  assert.ok(none.includes('graph TD; A-->B;'), 'mermaid survives none mode');

  // blob sanity: base64 output decodes back to the source bytes
  const m = b64.match(/base64,([A-Za-z0-9+/=]+)\)/);
  assert.ok(Buffer.from(m[1], 'base64').equals(Buffer.from(png)), 'base64 round-trip equals source bytes');

  console.log('Image output modes: OK');
}

{
  const { renderMarkdown } = await import('../src/widget.js');
  const { renderControls } = await import('../src/semantic.js');
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| escaped \\| pipe | tail |\n| | empty |');
  assert.match(html, /<td>escaped \| pipe<\/td>\s*<td>tail<\/td>/);
  assert.match(html, /<td><\/td>\s*<td>empty<\/td>/);
  const blocks = renderMarkdown([
    '- [x] Done', '  - Nested', '', '4. Fourth', '', '$$', '\\begin{aligned}',
    'x &= y \\\\', 'z &= \\frac{1}{2}', '\\end{aligned}', '$$', '',
    'Inline $\u005cfrac{1}{2}$ and **bold with *italics***.', '',
    '~~~text', '| not a table |', '~~~', '', '<img src="https://example.test/x">',
  ].join('\n'), [], { allowRawHtml: false });
  assert.match(blocks, /<input type="checkbox" aria-label="Checked" disabled checked>/);
  assert.match(blocks, /<ul>\s*<li>Nested<\/li>/);
  assert.match(blocks, /<ol start="4">/);
  assert.match(blocks, /<div class="math">\$\$\n\\begin\{aligned\}/);
  assert.match(blocks, /<span class="math-inline">\$\\frac\{1\}\{2\}\$<\/span>/);
  assert.match(blocks, /<strong>bold with <em>italics<\/em><\/strong>/);
  assert.match(blocks, /<code class="language-text">\| not a table \|/);
  assert.doesNotMatch(blocks, /<img\b|<table\b/);
  const name = 'topmostSubform[0].Page1[0].f1_01[0]';
  const fields = renderControls([{ page: 1, type: 'text', name, label: name, labelSource: 'field-name' }]);
  assert.match(fields, /<label[^>]*>Field 1<\/label>/);
  assert.ok(fields.includes('name="' + name + '"'), 'keep internal name as metadata');
}

console.log(`\nALL TESTS PASSED  (init+parse: ${initParseMs} ms, stats.ms: ${doc.stats.ms} ms)`);
