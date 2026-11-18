// Usage: node tools/benchmark-raster.mjs prepare|run <pdf-folder> <output-dir>
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { IngestLab } from '../src/index.js';
import { extractPage, openDocument } from '../src/pdfio.js';

const [action, path, output] = process.argv.slice(2);
if (!['prepare', 'run'].includes(action) || !path || !output) {
  throw new Error('Usage: node tools/benchmark-raster.mjs prepare|run <pdf-folder> <output-dir>');
}
const root = resolve(output);
await mkdir(root, { recursive: true });
const write = (file, data) => writeFile(join(root, file), JSON.stringify(data, null, 2) + '\n');
const lab = await IngestLab.init();

if (action === 'prepare') {
  const files = await readdir(path);
  const panels = [];
  for (const suite of [1, 2]) {
    const file = files.find((f) => f.normalize('NFC') ===
      's\u01a1 \u0111\u1ed3 v\u00e0 bi\u1ec3u \u0111\u1ed3 ' + suite + '.pdf');
    assert.ok(file, 'Missing suite ' + suite);
    const source = resolve(path, file);
    const doc = await lab.parse(await readFile(source), { cache: false, ocr: false, imageMode: 'none' });
    const figures = doc.figures.filter((f) => f.bbox.sourcePanel);
    if (suite === 1) {
      const ids = figures.map((f) => Number(f.bbox.caption.match(/^Figure (\d+)/)?.[1]));
      assert.deepEqual(ids, Array.from({ length: 86 }, (_, i) => i + 1));
    }
    for (const f of figures) {
      const { x0, x1, y0, y1, caption } = f.bbox;
      panels.push({ id: 'S' + suite + '-' + (panels.filter((p) => p.suite === suite).length + 1),
        suite, source, page: f.page, box: [x0, y0, x1, y1], caption, family: f.kind2 || f.bbox.kind });
    }
  }
  await write('panels.json', panels);
  console.log('Located ' + panels.length + ' source panels');
  process.exit(0);
}

const tokens = (s) => (String(s).normalize('NFKC').toLowerCase().replace(/\u2212/g, '-')
  .match(/[+-]?\d+(?:[.,]\d+)*%?|\p{L}+(?:[-']\p{L}+)*\d*/gu) || []);
const matching = (expected, actual) => {
  const counts = new Map();
  for (const a of actual) counts.set(a, (counts.get(a) || 0) + 1);
  return expected.filter((e) => {
    if (!(counts.get(e) > 0)) return false;
    counts.set(e, counts.get(e) - 1);
    return true;
  }).length;
};
const canonical = (s) => tokens(s).join(' ');
const cells = (rs) => rs.map((r) => r.map(canonical).join(' | '));
function compare(expected, visual) {
  if (!expected) return null;
  if (!visual || visual.kind !== expected.kind) return 'missing or wrong type';
  if (expected.kind === 'diagram') {
    const key = ([a, b, d]) => [canonical(a), d ? '->' : '--', canonical(b)].join(' ');
    const actualEdges = visual.edges.map(([a, b, d]) => key([visual.nodes[a], visual.nodes[b], d]));
    const want = expected.edges.map(key);
    const edges = matching(want, actualEdges);
    const nodes = matching(expected.nodes.map(canonical), visual.nodes.map(canonical));
    return nodes === expected.nodes.length && nodes === visual.nodes.length &&
      edges === want.length && edges === actualEdges.length ? 'exact' :
      `nodes ${nodes}/${expected.nodes.length}; edges ${edges}/${want.length}; extra edges ${actualEdges.length - edges}`;
  }
  const expectedRows = cells(expected.rows), actualRows = cells(visual.rows);
  const rows = matching(expectedRows, actualRows);
  return rows === expectedRows.length && rows === actualRows.length &&
    JSON.stringify(cells([expected.headers])) === JSON.stringify(cells([visual.headers])) ?
    visual.approximate ? 'numeric match; estimated' : 'exact' :
    `rows ${rows}/${expectedRows.length}; extra rows ${actualRows.length - rows}`;
}

const manifest = JSON.parse(await readFile(join(root, 'cases.json'), 'utf8'));
const results = [];
for (const group of manifest) {
  const bytes = readFile(join(root, group.file));
  const { doc, pdfjs, task } = await openDocument(new Uint8Array(await bytes));
  try {
    assert.equal(doc.numPages, group.cases.length);
    for (const [i, sample] of group.cases.entries()) {
      const page = await extractPage(await doc.getPage(i + 1), pdfjs);
      assert.equal(page.images.length, 1, sample.id);
      assert.equal(page.drawPts.length, 0, sample.id);
      assert.deepEqual(page.words.map((w) => w.str), group.scan ? [] : ['Sample', sample.id], sample.id);
    }
  } finally { await task.destroy(); }
  console.log('OCR ' + group.file + ': ' + group.cases.length + ' verified raster pages');
  const result = await lab.parse(await bytes, { cache: false, imageMode: 'none', ocrLangs: 'eng', ocrAutoLang: false });
  assert.equal(result.stats.ocrFailed + result.stats.imageOcrFailed, 0, group.file);
  assert.doesNotMatch(result.markdown, /^!\[/m);
  await writeFile(join(root, group.file.replace(/\.pdf$/, '.md')), result.markdown);
  const pages = result.pages.map((blocks, i) => {
    const sample = group.cases[i];
    const image = blocks.find((b) => b.type === 'image');
    const text = blocks.flatMap((b) => {
      if (b.type !== 'image') return group.scan ? b.rows ? b.rows.flat() : [b.text || ''] : [];
      if (b.rasterVisual?.kind === 'diagram') return [...b.rasterVisual.nodes, ...b.rasterVisual.labels];
      if (b.rasterVisual?.kind === 'table') return [b.rasterVisual.headers, ...b.rasterVisual.rows].flat();
      return b.ocrLines || [];
    }).join(' ');
    const expected = tokens(sample.referenceText || '');
    const actual = tokens(text);
    const visual = image?.rasterVisual;
    const structured = visual?.kind || (group.scan && blocks.some((b) => b.type === 'table') ? 'page table' : null);
    return { ...sample, mode: group.scan ? 'scan' : 'embedded', placement: !!image, structured,
      textMatch: matching(expected, actual), textExpected: expected.length, textRead: actual.length,
      check: compare(sample.expected, visual), text, visual };
  });
  results.push(...pages);
  await write('results.json', results);
}

const report = ['# Raster OCR benchmark', '',
  'Only the case ID remains as native text in embedded PDFs. Scan cases contain no native text.',
  'No vector paths or source answers enter OCR. Images are not included in the exported Markdown.',
  'Text recall uses token multiset overlap with the source PDF text in the crop. It is not a topology or data score.',
  'Exact checks require all authored nodes and directed edges, or all table headers and rows, with no extras. Matching estimates are reported separately.',
  'Source panels without a manual structural reference are ungraded for correctness.', '',
  '| Set | Cases | Image placements | OCR text | Structured | Exact / graded | Text recall |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const [label, cases] of [
  ['Suite 1', results.filter((r) => r.suite === 1)],
  ['Suite 2', results.filter((r) => r.suite === 2)],
  ['Synthetic embedded', results.filter((r) => !r.suite && r.mode === 'embedded')],
  ['Synthetic scan', results.filter((r) => r.mode === 'scan')],
]) {
  const text = cases.reduce((n, r) => n + r.textExpected, 0), hits = cases.reduce((n, r) => n + r.textMatch, 0);
  report.push('| ' + [label, cases.length, cases.filter((r) => r.placement).length,
    cases.filter((r) => r.textRead).length, cases.filter((r) => r.structured).length,
    cases.filter((r) => r.check === 'exact').length + '/' + cases.filter((r) => r.check).length,
    text ? (hits * 100 / text).toFixed(1) + '%' : '-'].join(' | ') + ' |');
}
const esc = (s) => String(s || '-').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
report.push('', '## Per Case', '', '| ID | Source page | Caption | Output | Exact check | Text tokens matched |',
  '| --- | ---: | --- | --- | --- | ---: |');
for (const r of results) report.push('| ' + [r.id, r.page, r.caption, r.structured || (r.textRead ? 'OCR text only' : 'No result'),
  r.check || 'Not graded', r.textMatch + '/' + r.textExpected].map(esc).join(' | ') + ' |');
await writeFile(join(root, 'report.md'), report.join('\n') + '\n');
console.log(report.slice(8, 15).join('\n'));
