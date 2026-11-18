// OCR gate for scanned PDFs (slow — runs lang-data download + WASM inference).
//   npm run test:ocr
// Uses the first 2 pages of the scanned law document: they must contain the
// legal heading patterns (Điều/Chương) after OCR feeds the regular pipeline.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { IngestLab } from '../src/index.js';

const UPLOAD = process.env.INGESTLAB_PDF_DIR || fileURLToPath(new URL('../../pdf', import.meta.url));
if (!existsSync(UPLOAD)) {
  console.log('PDF fixtures not present — OCR smoke skipped');
  process.exit(0);
}
const name = readdirSync(UPLOAD).find((n) => n.normalize('NFC').includes('Luat dat dai'));
if (!name) {
  console.log('scanned law PDF not present — OCR smoke skipped');
  process.exit(0);
}
const t0 = Date.now();
const lab = await IngestLab.init();
const doc = await lab.parse(new Uint8Array(readFileSync(`${UPLOAD}/${name}`)), { cache: false, ocrPageLimit: 2 });
const md = doc.markdown;
console.log(`OCR smoke: ${doc.stats.ocrPages} page(s) OCR'd in ${Math.round((Date.now() - t0) / 1000)}s, words=${doc.stats.words}`);
assert.ok(doc.stats.ocrPages >= 1, 'at least one page went through OCR');
assert.ok(/(Điều|CHƯƠNG|Chương)/u.test(md), `OCR text contains legal headings (got: ${md.slice(0, 160).replace(/\n/g, ' ')})`);
console.log('OCR smoke: OK');

const raster = readdirSync(UPLOAD).find((n) => n === 'LM358 (1).pdf');
if (raster) {
  const visual = await lab.parse(readFileSync(`${UPLOAD}/${raster}`), {
    cache: false, imageMode: 'none', ocrImages: true, ocrLangs: 'eng',
  });
  assert.equal(visual.stats.imageOcrFailed, 0);
  assert.ok(visual.stats.imageOcrRegions > 0);
  assert.match(visual.markdown, /\*\*Text read from the image \(OCR\)\*\*\n\n- \S/);
  assert.doesNotMatch(visual.markdown, /^!\[/m);
  console.log('Embedded-image OCR smoke: OK');
}

const rasterVisuals = (visual, page) => visual.pages[page - 1]
  .filter((b) => b.type === 'image' && b.rasterVisual).map((b) => b.rasterVisual);
const parseVisuals = (file, options = {}) => lab.parse(readFileSync(`${UPLOAD}/${file}`), {
  cache: false, imageMode: 'none', ...options,
});
const transformer = await parseVisuals('1706.03762v7.pdf');
assert.equal(transformer.stats.ocrPages, 0);
assert.equal(transformer.stats.imageOcrFailed, 0);
const graph = (v) => v.edges.filter(([, , directed]) => directed).map(([a, b]) => [v.nodes[a], v.nodes[b]].join(' -> '));
assert.equal(rasterVisuals(transformer, 3).length, 1);
assert.ok(graph(rasterVisuals(transformer, 3)[0]).includes('Linear -> Softmax'));
const attention = rasterVisuals(transformer, 4);
assert.equal(attention.length, 2);
const scaled = graph(attention.find((v) => v.nodes.includes('MatMul')));
for (const e of ['Q -> MatMul', 'K -> MatMul', 'V -> MatMul', 'MatMul -> Scale', 'Scale -> Mask (opt.)', 'Mask (opt.) -> SoftMax', 'SoftMax -> MatMul'])
  assert.ok(scaled.includes(e), e);
assert.ok(!scaled.includes('Scale -> MatMul'));
const multi = graph(attention.find((v) => v.nodes.includes('Concat')));
assert.equal(multi.filter((e) => e === 'Linear -> Scaled Dot-Product Attention').length, 3);
assert.ok(multi.includes('Scaled Dot-Product Attention -> Concat'));
assert.ok(multi.includes('Concat -> Linear'));
assert.match(transformer.markdown, /```mermaid\nflowchart BT/);
assert.doesNotMatch(transformer.markdown, /^!\[/m);

const vietnam = await parseVisuals('viet-nam-2025.pdf');
assert.equal(vietnam.stats.imageOcrFailed, 0);
const scores = rasterVisuals(vietnam, 1);
assert.deepEqual(scores.find((v) => v.kind === 'radial').rows, [
  ['Regulatory Framework', '67'], ['Public Services', '54'], ['Operational Efficiency', '70'],
]);
assert.deepEqual(Object.fromEntries(scores.filter((v) => v.kind === 'radial-score').flatMap((v) => v.rows)), {
  'BUSINESS ENTRY': '77', 'BUSINESS LOCATION': '60', 'UTILITY SERVICES': '90', LABOR: '70',
  'FINANCIAL SERVICES': '80', 'INTERNATIONAL TRADE': '62', TAXATION: '59', 'DISPUTE RESOLUTION': '56',
  'MARKET COMPETITION': '48', 'BUSINESS INSOLVENCY': '36',
});
assert.match(vietnam.markdown, /\| MARKET COMPETITION \| 48 \|/);
const disabled = await parseVisuals('1706.03762v7.pdf', { ocrImages: false });
assert.equal(disabled.stats.imageOcrRegions, 0);
console.log('Embedded-image visual regression: Transformer arrows and Viet Nam printed scores OK');
