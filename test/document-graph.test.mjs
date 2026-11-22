import assert from 'node:assert/strict';
import { addControlsToGraph, buildDocumentGraph, linkContainedElements } from '../src/index.js';
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
assert.equal(stitched[1].length, 1);
assert.equal(stitched[1][0]._continuedDuplicate, true);
const controls = addControlsToGraph(buildDocumentGraph([[]]), [{ page: 1, type: 'checkbox', source: 'acroform', bbox: { x0: 1, y0: 2, x1: 9, y1: 10 }, label: 'Agree', checked: true }]);
assert.equal(controls.elements.at(-1).type, 'checkbox');
assert.equal(controls.elements.at(-1).control.checked, true);
const nested = linkContainedElements(buildDocumentGraph([[
  { type: 'figure', kind: 'diagram', bbox: { x0: 0, y0: 0, x1: 100, y1: 100 } },
  { type: 'paragraph', text: 'label', bbox: { x0: 10, y0: 10, x1: 40, y1: 20 } },
]]));
assert.deepEqual(nested.relations.at(-1), { from: 'p1-b0', to: 'p1-b1', type: 'contains' });
const worksheet = buildDocumentGraph([[{ type: 'worksheet', rows: [{ code: '1', label: 'Income', amount: '10' }] }]]);
assert.equal(worksheet.elements[0].type, 'form_field');
assert.equal(worksheet.elements[0].children, undefined);
console.log('Document graph provenance: OK');
