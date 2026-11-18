import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IngestLab } from '../src/index.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node tools/visual-coverage.mjs <pdf-folder>');
  process.exit(2);
}
const names = await readdir(input);
const lab = await IngestLab.init();
const tableCell = (s) => String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
console.log('# Visual corpus coverage\n');
console.log('Generated from the two diagram PDFs. A detected source panel is not proof of a correct editable reconstruction.');
console.log('Geometry: measured shapes or printed values. Relations: observed connectors (direction only when established).');
console.log('Labels: transcription only, not a reconstruction of data or topology. Heuristic output still needs review.\n');
for (const n of [1, 2]) {
  const name = names.find((f) => f.normalize('NFC') === 's\u01a1 \u0111\u1ed3 v\u00e0 bi\u1ec3u \u0111\u1ed3 ' + n + '.pdf');
  if (!name) throw new Error('Expected diagram fixture ' + n);
  const doc = await lab.parse(await readFile(join(input, name)), { imageMode: 'none', ocr: false, cache: false });
  const named = doc.figures.flatMap((f) => {
    const caption = f.bbox.caption;
    const id = caption?.match(/^(Figure|Level)\s+(\d+(?:\.\d+)?)/);
    return id ? [{ f, caption, id: id[1] + ' ' + id[2] }] : [];
  });
  const rows = [...new Map(named.map((r) => [r.id, r])).values()].sort((a, b) =>
    a.id.localeCompare(b.id, 'en', { numeric: true }));
  const anonymous = doc.figures.filter((f) => f.reconstruction === 'geometry' && !named.some((r) => r.f === f));
  const counts = ['geometry', 'relations', 'heuristic', 'labels', 'none']
    .map((kind) => rows.filter(({ f }) => f.reconstruction === kind).length);
  console.log('## ' + name + '\n');
  console.log(rows.length + ' named panels: ' + counts[0] + ' geometry, ' + counts[1] + ' relations, ' +
    counts[2] + ' heuristic, ' + counts[3] + ' labels only, ' + counts[4] + ' source only. ' +
    anonymous.length + ' additional geometry reconstructions without a numbered caption.\n');
  if (n === 2) console.log('Taxonomy rows that list levels without a corresponding panel are not counted as completed figures.\n');
  console.log('| Sample | Source page | Status | Editable output |');
  console.log('| --- | ---: | --- | --- |');
  for (const { f, caption } of rows) console.log('| ' + tableCell(caption) + ' | ' + f.page + ' | ' +
    (f.reconstruction === 'none' ? 'Source only' : f.reconstruction) + ' | ' +
    (f.reconstruction === 'none' ? '-' : [
      f.mermaid && 'Mermaid', f.tableMd && 'data table', f.visualContent?.links?.length && 'relationship table',
      f.visualContent?.labels?.length && 'label list',
    ].filter(Boolean).join(', ')) + ' |');
  for (const f of anonymous) console.log('| ' + tableCell(f.bbox.caption || 'Panel without a numbered caption') +
    ' | ' + f.page + ' | geometry | ' + tableCell(f.kind2 || 'diagram') + ' (' +
    [f.mermaid && 'Mermaid', f.tableMd && 'table'].filter(Boolean).join(', ') + ') |');
  console.log('');
}
