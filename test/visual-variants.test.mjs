import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IngestLab } from '../src/index.js';

const lab = await IngestLab.init();
for (const { variant, entries, nodes, estimated } of [
  { variant: 'printed', entries: [['North', '37'], ['South', '63'], ['West', '82']],
    nodes: ['Receive', 'Validate', 'Archive'], estimated: false },
  { variant: 'estimated', entries: [['Alpha', '~24'], ['Beta', '~51'], ['Gamma', '~76'], ['Delta', '~89']],
    nodes: ['Collect', 'Review', 'Publish'], estimated: true },
]) {
  const bytes = await readFile(new URL('./fixtures/visual-' + variant + '.pdf', import.meta.url));
  const compact = await lab.parse(bytes, { ocr: false });
  assert.equal(compact.imageMode, 'none');
  assert.equal(compact.assets.length, 0);
  assert.doesNotMatch(compact.markdown, /^!\[|<svg|> \[Image:/m);
  assert.ok(compact.markdown.length < 1000);
  const [chart, flow] = compact.figures;
  assert.equal(compact.figures.length, 2);
  assert.equal(chart.kind2, 'bar');
  assert.match(chart.mermaid, /^xychart-beta\n/);
  assert.equal(flow.kind2, 'flowchart');
  assert.deepEqual(chart.data.rows, entries);
  assert.equal(compact.markdown.includes('estimated from the chart geometry'), estimated);
  assert.deepEqual([...flow.mermaid.matchAll(/N\d+\["([^"]+)"\]/g)].map((m) => m[1]), nodes);
  assert.deepEqual(flow.mermaid.split('\n').filter((s) => s.includes('-->')).map((s) => s.trim()),
    ['N0 --> N1', 'N1 --> N2']);
  for (const [label] of entries) assert.equal(compact.markdown.split(label).length, 3);
  for (const label of nodes) assert.equal(compact.markdown.split(label).length, 2);
}
console.log('Independent PDF variants: axis-calibrated bars, directed flows, compact Markdown OK');
