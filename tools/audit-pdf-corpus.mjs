import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { IngestLab } from '../src/index.js';

const args = process.argv.slice(2);
const [folder = '../pdf/corpus-150/synthetic', output = 'output/pdf/corpus-150/audit.json', markdownDir] =
  args.filter((arg) => !arg.startsWith('--'));
if (markdownDir) await mkdir(markdownDir, { recursive: true });
const fixtures = JSON.parse(await readFile(join(folder, 'ground-truth.json'), 'utf8'));
const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const sameBounds = (a, b) => a && b &&
  ['x0', 'x1', 'y0', 'y1'].every((key) => Math.abs(a[key] - b[key]) <= 5);
const matchesTable = (table, target, scan) => table.rows.slice(0, 2)
  .some((row) => row.some((cell) => norm(cell).split(' ').includes(target.anchor))) ||
  (scan && sameBounds(table.bbox, target.bbox));
const lab = await IngestLab.init();
const results = [];

for (const fixture of fixtures) {
  const scan = fixture.variant === 'scan-with-margin';
  const result = await lab.parse(await readFile(join(folder, fixture.file)), {
    cache: false,
    dropHeadersFooters: false,
    ocr: scan,
    ocrLangs: 'eng',
    ocrImages: false,
  });
  if (markdownDir) await writeFile(join(markdownDir, fixture.file.replace(/\.pdf$/, '.md')), result.markdown);
  const checks = { cells: 0, cellsMatched: 0, spans: 0, spansMatched: 0,
    orderedPages: 0, tables: 0, tablesMatched: 0, tableShapesMatched: 0, controls: 0, controlsMatched: 0 };
  const differences = [];
  for (const [i, expected] of fixture.pages.entries()) {
    const tables = (result.pages[i] || []).filter((b) => b.type === 'table');
    const order = [];
    for (const table of tables) {
      const names = expected.tables.filter((target) => matchesTable(table, target, scan)).map((target) => target.anchor);
      order.push(...names);
    }
    if (tables.length === expected.tables.length && JSON.stringify(order) === JSON.stringify(expected.order)) {
      checks.orderedPages++;
    } else {
      differences.push({ page: i + 1, tableCount: tables.length, order, expected: expected.order });
    }

    for (const target of expected.tables) {
      const table = tables.find((candidate) => matchesTable(candidate, target, scan));
      checks.tables++;
      if (table) checks.tablesMatched++;
      if (table?.rows.length === target.rows.length &&
          table.rows.every((row, r) => row.length === target.rows[r].length)) checks.tableShapesMatched++;
      let cellErrors = 0;
      target.rows.forEach((row, r) => row.forEach((cell, c) => {
        checks.cells++;
        if (table && c < (table.rows[r]?.length ?? 0) && norm(table.rows[r][c]) === norm(cell)) checks.cellsMatched++;
        else cellErrors++;
      }));
      for (const span of target.spans) {
        checks.spans++;
        if (table?.spans?.some((s) => s.r === span.r && s.c === span.c &&
            s.rowspan === span.rowspan && s.colspan === span.colspan)) checks.spansMatched++;
      }
      if (cellErrors) differences.push({ page: i + 1, table: target.anchor, cellErrors,
        firstRows: table?.rows.slice(0, 3) });
    }
    for (const control of expected.controls) {
      checks.controls++;
      const actual = result.controls.find(({ name, page }) => name === control.name && page === i + 1);
      if (actual?.type === control.type && actual.label === control.label &&
          (control.type === 'checkbox' ? actual.checked === control.checked : actual.value === control.value)) {
        checks.controlsMatched++;
      } else differences.push({ page: i + 1, control: control.name });
    }
  }
  results.push({ file: fixture.file, variant: fixture.variant, pages: fixture.pages.length, checks, differences });
}
const summary = {};
for (const { variant, pages, checks } of results) {
  const totals = summary[variant] ||= { files: 0, pages: 0 };
  totals.files++;
  totals.pages += pages;
  for (const [key, count] of Object.entries(checks)) totals[key] = (totals[key] || 0) + count;
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ summary, results }, null, 2) + '\n');
console.table(summary);
if (args.includes('--assert-vector')) {
  const failed = results.filter(({ variant, pages, checks: c }) => variant !== 'scan-with-margin' &&
    (c.orderedPages !== pages || c.tableShapesMatched !== c.tables ||
      c.cellsMatched !== c.cells || c.spansMatched !== c.spans ||
      c.controlsMatched !== c.controls));
  if (failed.length) {
    console.error('Vector layout mismatches:', failed.map(({ file }) => file).join(', '));
    process.exitCode = 1;
  }
}
