import assert from 'node:assert/strict';
import { buildDocumentGraph } from '../src/index.js';
import { mergeContinuedTables } from '../src/tableContinuations.js';

const graph = buildDocumentGraph([[
  { type: 'heading', text: 'Income', bbox: { x0: 10, y0: 20, x1: 200, y1: 30 }, prov: 'structTree' },
  { type: 'table', kind: 'ruled', rows: [['Line', 'Value'], ['1', '100']], bbox: { x0: 10, y0: 40, x1: 200, y1: 80 }, sources: [{ page: 1, blockIndex: 1 }] },
]], { fingerprint: 'fixture', pageData: [{ width: 300, height: 400, words: [{ str: 'Income', x0: 10, x1: 45, y: 29, size: 10 }] }] });

assert.equal(graph.version, 1);
assert.equal(graph.fingerprint, 'fixture');
assert.deepEqual(graph.pages[0].elements, ['p1-b0', 'p1-b1']);
assert.equal(graph.elements[0].type, 'heading');
assert.equal(graph.elements[0].provenance, 'structTree');
assert.equal(graph.elements[0].sourceWords[0].text, 'Income');
const table = graph.elements.find(({ id }) => id === 'p1-b1');
assert.deepEqual(table.children, ['p1-b1-r0-c0', 'p1-b1-r0-c1', 'p1-b1-r1-c0', 'p1-b1-r1-c1']);
assert.equal(graph.elements.find(({ id }) => id === 'p1-b1-r1-c1').text, '100');
assert.deepEqual(graph.elements.find(({ id }) => id === 'p1-b1-r1-c1').bbox, { x0: 105, y0: 60, x1: 200, y1: 80 });
assert.deepEqual(graph.relations, []);
const continued = buildDocumentGraph([
  [{ type: 'table', rows: [['Line', 'Value'], ['1', '100']] }],
  [{ type: 'table', rows: [['Line', 'Value'], ['2', '200']] }],
]);
assert.deepEqual(continued.relations, [{ from: 'p1-b0', to: 'p2-b0', type: 'continued_table' }]);
const stitched = mergeContinuedTables([
  [{ type: 'table', meta: { headerRows: 1 }, rows: [['Line', 'Value'], ['1', '100']] }],
  [{ type: 'table', meta: { headerRows: 1 }, rows: [['Line', 'Value'], ['2', '200']] }],
]);
assert.deepEqual(stitched[0][0].rows, [['Line', 'Value'], ['1', '100'], ['2', '200']]);
assert.equal(stitched[1].length, 0);
console.log('Document graph provenance: OK');
