import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { IngestLab } from '../src/index.js';

const root = resolve(process.argv[2] || '../pdf/corpus-150/synthetic');
const output = resolve(process.argv[3] || 'output/pdf/document-graph-benchmark.json');
const names = (await readdir(root)).filter((name) => name.endsWith('.pdf')).sort();
const truthPath = join(root, 'ground-truth.json');
const truth = JSON.parse(await readFile(truthPath, 'utf8').catch(() => '[]'));
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const lab = await IngestLab.init();
const files = [];
const totals = { pages: 0, elements: 0, cells: 0, tables: 0, figures: 0, forms: 0, formulas: 0, invalidSources: 0, duplicateIds: 0, tableAnchors: 0, tableAnchorsFound: 0 };
const durations = [];

for (const name of names) {
  const started = performance.now();
  const result = await lab.parse(new Uint8Array(await readFile(join(root, name))), {
    ocr: false, figures: false, vectorFigures: false, cache: false, dropHeadersFooters: false,
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
  for (const page of expected?.pages || []) for (const table of page.tables || []) {
    tableAnchors++;
    const found = graph.elements.some((element) => element.type === 'table' &&
      normalize(element.text).includes(normalize(table.anchor)));
    if (found) tableAnchorsFound++;
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
  },
  latency: { p95Ms: Math.round(p95 * 10) / 10 },
  results: files,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ files: report.files, totals, quality: report.quality, latency: report.latency }, null, 2));
if (totals.invalidSources || totals.duplicateIds || totals.tableAnchorsFound !== totals.tableAnchors) process.exitCode = 1;
