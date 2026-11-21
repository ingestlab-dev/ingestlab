import assert from 'node:assert/strict';
import { buildDocumentGraph } from '../src/index.js';

const graph = buildDocumentGraph([[
  { type: 'heading', text: 'Income', bbox: { x0: 10, y0: 20, x1: 200, y1: 30 }, prov: 'structTree' },
  { type: 'table', kind: 'ruled', rows: [['Line', 'Value'], ['1', '100']], bbox: { x0: 10, y0: 40, x1: 200, y1: 80 }, sources: [{ page: 1, blockIndex: 1 }] },
]], { fingerprint: 'fixture', pageData: [{ width: 300, height: 400 }] });

assert.equal(graph.version, 1);
assert.equal(graph.fingerprint, 'fixture');
assert.deepEqual(graph.pages[0].elements, ['p1-b0', 'p1-b1']);
assert.equal(graph.elements[0].type, 'heading');
assert.equal(graph.elements[0].provenance, 'structTree');
const table = graph.elements.find(({ id }) => id === 'p1-b1');
assert.deepEqual(table.children, ['p1-b1-r0-c0', 'p1-b1-r0-c1', 'p1-b1-r1-c0', 'p1-b1-r1-c1']);
assert.equal(graph.elements.find(({ id }) => id === 'p1-b1-r1-c1').text, '100');
assert.deepEqual(graph.elements.find(({ id }) => id === 'p1-b1-r1-c1').bbox, { x0: 105, y0: 60, x1: 200, y1: 80 });
assert.deepEqual(graph.relations, []);
console.log('Document graph provenance: OK');
