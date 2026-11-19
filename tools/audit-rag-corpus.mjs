import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { IngestLab } from '../src/index.js';

const root = resolve(process.argv[2] || '../pdf/corpus-150');
const output = resolve(process.argv[3] || 'output/pdf/corpus-150/rag-audit.json');
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const sameBounds = (a, b) => a && b && ['x0', 'x1', 'y0', 'y1']
  .every((key) => Math.abs(Number(a[key]) - Number(b[key])) <= 8);
const files = async (folder) => (await import('node:fs/promises')).readdir(folder)
  .then((names) => names.filter((name) => name.endsWith('.pdf')).sort());

const lab = await IngestLab.init();
const summary = { files: 0, pages: 0, tables: 0, chunks: 0, validSources: 0, sourceRefs: 0,
  uniqueIds: 0, tableAnchors: 0, tableAnchorsFound: 0, failedFiles: 0, scanFiles: 0 };
const results = [];

async function auditFile(folder, name, expected = null) {
  const scan = expected?.variant === 'scan-with-margin';
  const options = {
    cache: false, ocr: scan, ocrLangs: scan ? 'eng' : undefined,
    ocrImages: false, figures: false, vectorFigures: false,
    imageMode: 'none', dropHeadersFooters: false, markdownProfile: 'rag',
  };
  if (scan && process.env.INGESTLAB_TESSDATA_DIR) {
    options.ocrRuntime = { langPath: process.env.INGESTLAB_TESSDATA_DIR, gzip: false };
  }
  const result = await lab.parse(await readFile(join(folder, name)), options);
  const ids = new Set();
  let validSources = 0;
  let sourceRefs = 0;
  let invalidSources = 0;
  for (const chunk of result.ragChunks || []) {
    if (ids.has(chunk.id)) throw new Error(`duplicate chunk id ${chunk.id}`);
    ids.add(chunk.id);
    if (!chunk.text.trim() || !chunk.sources?.length) throw new Error(`empty chunk ${chunk.id}`);
    for (const source of chunk.sources) {
      sourceRefs++;
      const block = result.pages[source.page - 1]?.[source.blockIndex];
      const valid = !!block && (source.rowIndex === undefined || !!block.rows?.[source.rowIndex]);
      if (valid) validSources++;
      else { invalidSources++; }
    }
  }
  const anchorChecks = [];
  for (const [pageIndex, page] of (expected?.pages || []).entries()) for (const table of page.tables || []) {
    summary.tableAnchors++;
    const detectedIndex = (result.pages[pageIndex] || []).findIndex((candidate) => candidate.type === 'table' &&
      (candidate.rows.slice(0, 2).some((row) => row.some((cell) => normalize(cell).includes(normalize(table.anchor)))) ||
       (scan && sameBounds(candidate.bbox, table.bbox))));
    const found = detectedIndex >= 0 && (result.ragChunks || []).some((chunk) =>
      chunk.sources.some((source) => source.page === pageIndex + 1 && source.blockIndex === detectedIndex));
    if (found) summary.tableAnchorsFound++;
    anchorChecks.push({ anchor: table.anchor, found });
  }
  if (invalidSources) throw new Error(`${invalidSources} invalid source references`);
  return {
    file: name,
    variant: expected?.variant || 'real',
    pages: result.stats.pages,
    tables: result.stats.tables,
    chunks: result.ragChunks?.length || 0,
    sourceRefs,
    validSources,
    uniqueIds: ids.size,
    anchorChecks,
  };
}

const folders = [
  ['real', join(root, 'real'), null],
  ['synthetic', join(root, 'synthetic'), JSON.parse(await readFile(join(root, 'synthetic', 'ground-truth.json'), 'utf8'))],
];
for (const [, folder, truth] of folders) {
  for (const name of await files(folder)) {
    const expected = truth?.find((fixture) => fixture.file === name) || null;
    try {
      const result = await auditFile(folder, name, expected);
      results.push(result);
      summary.files++;
      summary.pages += result.pages;
      summary.tables += result.tables;
      summary.chunks += result.chunks;
      summary.sourceRefs += result.sourceRefs;
      summary.validSources += result.validSources;
      summary.uniqueIds += result.uniqueIds;
      if (expected?.variant === 'scan-with-margin') summary.scanFiles++;
      console.log(`OK ${result.variant.padEnd(16)} ${name} pages=${result.pages} chunks=${result.chunks}`);
    } catch (error) {
      summary.failedFiles++;
      results.push({ file: name, error: String(error.message || error) });
      console.log(`FAIL ${name} ${error.message || error}`);
    }
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  root,
  summary: {
    ...summary,
    sourceAccuracy: summary.sourceRefs ? summary.validSources / summary.sourceRefs : 1,
    chunkIdUniqueness: summary.chunks ? summary.uniqueIds / summary.chunks : 1,
    tableAnchorRecall: summary.tableAnchors ? summary.tableAnchorsFound / summary.tableAnchors : 1,
  },
  results,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
if (summary.failedFiles || summary.validSources !== summary.sourceRefs || summary.tableAnchorsFound !== summary.tableAnchors)
  process.exitCode = 1;
