import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IngestLab } from '../src/index.js';
import { buildPageLayout, groupLines } from '../src/layout.js';
import { contentRect } from '../src/ocr.js';
import { detectRuledTables, findBorderlessTable } from '../src/tables.js';
import { pageOrderedBlocks } from '../src/rag.js';
import { renderPage } from '../src/render.js';

const word = (str, x, y, w = 18) => ({ str, x0: x, x1: x + w, y, size: 10, mono: false });
const line = (str, x, y, drift) => str.split(' ').map((part, i) => word(part, x + i * (25 + drift), y, 20));
const rows = Array.from({ length: 7 }, (_, i) => [
  ...line('Left' + i + ' keeps the first idea together', 58, 150 + 14 * i, i),
  ...line('Right' + i + ' keeps the next idea together', 330, 150 + 14 * i, i),
]);
const words = rows.flat();
const blocks = buildPageLayout({
  words, lines: groupLines(words), width: 612, height: 792, segments: { h: [], v: [] },
}, { body: 10, headingLevels: new Map() });
const prose = blocks.map((block) => block.text).join('\n');
assert.match(prose, /Left0 keeps the first idea together/);
assert.ok(prose.indexOf('Left6') < prose.indexOf('Right0'));
assert.match(prose, /Right6 keeps the next idea together/);

const panelWords = [
  word('Description', 40, 120, 70),
  word('Pin', 320, 120, 18), word('1', 345, 120, 8),
  word('The', 40, 140, 18), word('description', 65, 140, 55),
  word('OUTPUT', 320, 140, 38), word('1', 365, 140, 8),
  word('PKG', 320, 178, 22),
];
const panelBlocks = buildPageLayout({
  words: panelWords,
  lines: groupLines(panelWords),
  width: 420,
  height: 300,
  segments: { h: [], v: [] },
  figures: [{ bbox: { x0: 300, x1: 410, y0: 100, y1: 170, sourcePanel: true, caption: 'Pin assignments' } }],
}, { body: 10, headingLevels: new Map() });
const panelText = panelBlocks.map((block) => block.text || block.caption || '').join('\n');
assert.match(panelText, /The description/);
assert.doesNotMatch(panelText, /OUTPUT/);
const panelFigure = panelBlocks.find((block) => block.type === 'figure');
assert.deepEqual(panelFigure.extraLabels, ['PKG']);
assert.ok(panelFigure, 'panel figure keeps its own labels');
assert.doesNotMatch(panelText, /PKG/, 'adjacent panel label is not emitted as an orphan');

const joined = pageOrderedBlocks([[
  { type: 'paragraph', text: 'A paragraph split by the layout', _y1: 10 },
  { type: 'paragraph', text: 'engine keeps one context window.', _y1: 20 },
]]);
assert.equal(joined[0].text, 'A paragraph split by the layout engine keeps one context window.');

const justifiedText = ['The first definition continues below', 'under the terms already described', 'within each article of the act'];
const justifiedLines = justifiedText.map((text, i) => ({
  text, size: 10, x0: 40, x1: 215, y: 150 + 14 * i,
  words: text.split(' ').map((str, j) => word(str, 40 + 29 * j, 150 + 14 * i, 25)),
}));
assert.equal(findBorderlessTable(justifiedLines), null);

const gridWords = [
  word('One unbroken', 20, 48, 80), word('heading', 216, 48, 44),
  word('Label', 20, 79), word('March', 110, 79), word('April', 214, 79),
  word('Balance', 20, 111), word('1,050', 110, 111), word('1,200', 214, 111),
];
const [grid] = detectRuledTables(gridWords, {
  h: [30, 62, 94, 126].map((pos) => ({ pos, from: 12, to: 280 })),
  v: [12, 102, 204, 280].map((pos, i) => ({ pos, from: i === 0 || i === 3 ? 30 : 62, to: 126 })),
}, 330, 330);
assert.deepEqual(grid.rows[0], ['One unbroken heading', '', '']);
assert.deepEqual(grid.rows[2], ['Balance', '1,050', '1,200']);
assert.ok(grid.spans.some((span) => span.r === 0 && span.c === 0 && span.colspan === 3));

const w = 600;
const h = 800;
const data = new Uint8ClampedArray(w * h * 4).fill(255);
const paint = (x0, x1, y0, y1) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y * w + x) * 4] = 0;
};
for (let y = 80; y < 720; y += 22) paint(70, 538, y, y + 5);
for (let y = 190; y < 630; y += 13) paint(582, 594, y, y + 8);
const crop = contentRect({ w, h, data });
assert.ok(crop.left < 70 && crop.left + crop.width >= 538 && crop.left + crop.width < 582);
paint(500, 586, 120, 131);
const withConnectedText = contentRect({ w, h, data });
assert.ok(withConnectedText.left + withConnectedText.width >= 594);

// Image-only scan pages must avoid the native PDF.js canvas image path. Some
// RGB XObjects crash @napi-rs/canvas before JavaScript can catch an exception.
let pdfRenderCalled = false;
const scanPage = {
  getViewport: () => ({ width: 612, height: 792 }),
  getOperatorList: async () => ({ argsArray: [['scan-image', 1326, 1716]] }),
  objs: {
    get: (_name, callback) => callback({
      kind: 2,
      width: 1326,
      height: 1716,
      data: new Uint8Array(1326 * 1716 * 3).fill(255),
    }),
  },
  render: () => {
    pdfRenderCalled = true;
    throw new Error('scan image used the unsafe PDF.js canvas path');
  },
};
const scanRender = await renderPage(scanPage, 1);
assert.equal(pdfRenderCalled, false);
assert.ok(scanRender.canvas.toBuffer('image/png').length > 100);
scanRender.canvas.width = 0;
scanRender.canvas.height = 0;

const publicDir = process.env.INGESTLAB_PUBLIC_PDF_DIR;
if (publicDir) {
  const lab = await IngestLab.init();
  const parse = async (name, options) => lab.parse(await readFile(join(publicDir, name)), {
    cache: false, ocr: false, imageMode: 'none', dropHeadersFooters: false, ...options,
  });
  const article = await parse('acl-two-column.pdf');
  const intro = article.markdown.indexOf('## 1 Introduction');
  const topRight = article.markdown.indexOf('2018b), grouping of events');
  assert.ok(intro >= 0 && topRight > intro);
  assert.match(article.markdown, /demonstrated state-of-the-art performance in inferring the temporal ordering/);
  assert.doesNotMatch(article.markdown, /^of-the-art poral$/m);
  const ragArticle = await parse('acl-two-column.pdf', { markdownProfile: 'rag' });
  assert.equal(ragArticle.markdown, article.markdown);
  const passage = ragArticle.ragChunks.find(({ text }) =>
    text.includes('demonstrated state-of-the-art performance in inferring the temporal ordering'));
  assert.ok(passage?.sources.length);

  const pinout = await parse('nxp-pcf8574.pdf');
  const pins = pinout.pages[3].find((block) => block.type === 'table' && block.rows[0][0] === 'Symbol');
  assert.equal(pins.rows.length, 19);
  assert.deepEqual(pins.rows[2], ['A0', '1', '6', 'address input 0']);
  assert.deepEqual(pins.rows[9], ['VSS', '8', '15', 'supply ground']);
  assert.deepEqual(pins.rows.at(-1), ['n.c.', '-', '3, 8, 13, 18', 'not connected']);
  assert.match(pinout.markdown, /\| Symbol \| Pin \/ DIP16, SO16 \| Pin \/ SSOP20 \| Description \|/);

  const i9 = await parse('uscis-i9.pdf');
  const choices = i9.controls.filter((field) => field.page === 1 && field.name?.match(/^CB_[1-4]$/));
  assert.equal(choices.length, 4);
  assert.ok(choices.every((field) => !field.checked));
  assert.doesNotMatch(i9.markdown, /\[ \] \[x\]/i);
  assert.match(i9.markdown, /Section 1\. Employee Information and Attestation: Employees must complete and sign Section 1/);

  const tax = await parse('irs-f941.pdf');
  assert.match(tax.markdown, /\| 2 \| Wages, tips, and other compensation/);
  assert.match(tax.markdown, /Part 3: Tell us about your business/);

  const closing = await parse('cfpb-closing-disclosure.pdf');
  assert.match(closing.markdown, /\[x\] Conventional/);
  assert.match(closing.markdown, /\[x\] Property Taxes/);
  assert.match(closing.markdown, /\[ \] FHA/);
  assert.doesNotMatch(closing.markdown, /\[ \] x (?:Conventional|Property Taxes)/);
  console.log('Public PDF layouts: ACL, NXP, USCIS, IRS and CFPB OK');
}
console.log('PDF layout: equal baselines, merged heading and scan margin OK');
