import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { IngestLab } from '../src/index.js';

const root = resolve(process.argv[2] || '../pdf/corpus-150/synthetic');
const output = resolve(process.argv[3] || 'output/pdf/document-graph-benchmark.json');
const useOcr = process.argv.includes('--ocr');
const names = (await readdir(root)).filter((name) => name.endsWith('.pdf')).sort();
const truthPath = join(root, 'ground-truth.json');
const truth = JSON.parse(await readFile(truthPath, 'utf8').catch(() => '[]'));
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const iou = (a, b) => {
  if (!a || !b) return 0;
  const area = (box) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
  const intersection = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  const shared = area(intersection);
  return shared / Math.max(1, area(a) + area(b) - shared);
};
const lab = await IngestLab.init();
const files = [];
const totals = { pages: 0, elements: 0, cells: 0, tables: 0, figures: 0, forms: 0, formulas: 0, invalidSources: 0, duplicateIds: 0, tableAnchors: 0, tableAnchorsFound: 0, skippedOcrAnchors: 0, expectedCells: 0, foundCells: 0, bboxIouSum: 0, bboxChecks: 0, orderedFiles: 0, orderedFilesCorrect: 0 };
const durations = [];

for (const name of names) {
  const started = performance.now();
  const result = await lab.parse(new Uint8Array(await readFile(join(root, name))), {
    ocr: useOcr, figures: false, vectorFigures: false, cache: false, dropHeadersFooters: false,
  });
  const elapsedMs = performance.now() - started;
  const graph = result.documentGraph;
  const ids = new Set();
  let invalidSources = 0;
  for (const element of graph.elements) {
    if (ids.has(element.id)) totals.duplicateIds++;
    ids.add(element.id);
    for (const source of element.sources || []) {
      const block = result.pages[source.page - 1]?.[source.blockIndex];
      if (!block || (source.rowIndex !== undefined && !block.rows?.[source.rowIndex])) invalidSources++;
    }
  }
  const expected = truth.find((entry) => entry.file === name);
  let tableAnchors = 0;
  let tableAnchorsFound = 0;
  let expectedCells = 0;
  let foundCells = 0;
  let bboxIouSum = 0;
  let bboxChecks = 0;
  const expectedAnchors = [];
  for (const page of expected?.pages || []) for (const table of page.tables || []) {
    if (!useOcr && /scan|photo|skew/i.test(name)) {
      totals.skippedOcrAnchors++;
      continue;
    }
    tableAnchors++;
    expectedAnchors.push(normalize(table.anchor));
    const match = graph.elements.find((element) => element.type === 'table' && normalize(element.text).includes(normalize(table.anchor)));
    if (!match) continue;
    tableAnchorsFound++;
    for (const cell of table.rows.flat()) {
      if (!normalize(cell)) continue;
      expectedCells++;
      if (normalize(match.text).includes(normalize(cell))) foundCells++;
    }
    if (table.bbox && match.bbox) {
      bboxIouSum += iou(table.bbox, match.bbox);
      bboxChecks++;
    }
  }
  const actualAnchors = graph.elements.filter((element) => element.type === 'table').map((element) => normalize(element.text));
  const foundOrder = expectedAnchors.map((anchor) => actualAnchors.findIndex((text) => text.includes(anchor))).filter((index) => index >= 0);
  const ordered = foundOrder.length === expectedAnchors.length && foundOrder.every((index, i) => i === 0 || index > foundOrder[i - 1]);
  if (expectedAnchors.length) {
    totals.orderedFiles++;
    if (ordered) totals.orderedFilesCorrect++;
  }
  const counts = {};
  for (const element of graph.elements) (counts[element.type] ||= []).push(element);
  const row = {
    file: name,
    pages: graph.pages.length,
    elements: graph.elements.length,
    cells: counts.table_cell?.length || 0,
    tables: counts.table?.length || 0,
    figures: counts.figure?.length || 0,
    forms: counts.form_field?.length || 0,
    formulas: counts.formula?.length || 0,
    invalidSources,
    duplicateIds: graph.elements.length - ids.size,
    tableAnchors,
    tableAnchorsFound,
    expectedCells,
    foundCells,
    bboxIouSum,
    bboxChecks,
    ordered,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
  };
  files.push(row);
  durations.push(elapsedMs);
  for (const key of Object.keys(totals)) if (key in row) totals[key] += row[key];
}

durations.sort((a, b) => a - b);
const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : 0;
const report = {
  generatedAt: new Date().toISOString(), root, files: files.length,
  totals,
  quality: {
    sourceAccuracy: totals.elements ? 1 - totals.invalidSources / Math.max(1, totals.elements) : 1,
    chunkIdUniqueness: totals.duplicateIds === 0,
    tableAnchorRecall: totals.tableAnchors ? totals.tableAnchorsFound / totals.tableAnchors : 1,
    tableCellRecall: totals.expectedCells ? totals.foundCells / totals.expectedCells : 1,
    meanTableBboxIou: totals.bboxChecks ? totals.bboxIouSum / totals.bboxChecks : 1,
    tableOrderAccuracy: totals.orderedFiles ? totals.orderedFilesCorrect / totals.orderedFiles : 1,
  },
  latency: { p95Ms: Math.round(p95 * 10) / 10 },
  results: files,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ files: report.files, totals, quality: report.quality, latency: report.latency }, null, 2));
if (totals.invalidSources || totals.duplicateIds || totals.tableAnchorsFound !== totals.tableAnchors) process.exitCode = 1;
