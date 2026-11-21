import assert from 'node:assert/strict';
import {
  applyRecognizers,
  createChartRecognizer,
  createChemistryRecognizer,
  createFormulaRecognizer,
  createHandwritingRecognizer,
} from '../src/recognizers.js';

const pages = [[{ type: 'math', text: 'x + y', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } }]];
const result = await applyRecognizers(pages, [{ name: 'latex', types: ['formula'], recognize: ({ block }) => ({ text: `\\frac{${block.text}}{1}`, confidence: 0.97 }) }]);
assert.equal(result.applied, 1);
assert.equal(pages[0][0].text, '\\frac{x + y}{1}');
assert.equal(pages[0][0].prov, 'recognizer:latex');
assert.equal(result.failures.length, 0);
console.log('Recognizer adapter: OK');

const semanticPages = [[
  { type: 'math', text: 'a / b + √x ≤ y', prov: 'geometricFallback' },
  { type: 'paragraph', text: '2 H2 + O2 -> 2 H2O' },
  { type: 'figure', kind2: 'chart', text: 'Q1: 12\nQ2: 18' },
  { type: 'form_field', text: '', confidence: 0.2 },
]];
const semantic = await applyRecognizers(semanticPages, [
  createFormulaRecognizer(),
  createChemistryRecognizer(),
  createChartRecognizer(),
  createHandwritingRecognizer(),
]);
assert.equal(semantic.failures.length, 0);
assert.equal(semanticPages[0][0].latex, '\\frac{a}{b} + \\sqrt{x} \\leq y');
assert.equal(semanticPages[0][1].chemistry.format, 'mhchem');
assert.match(semanticPages[0][1].text, /^\\ce\{2 H2 \+ O2 -> 2 H2O\}$/);
assert.match(semanticPages[0][2].tableMd, /\| Q1 \| 12 \|/);
assert.match(semanticPages[0][2].mermaid, /xychart-beta/);
assert.equal(semanticPages[0][3].handwriting.candidate, true);
assert.equal(semanticPages[0][3].handwriting.recognized, false);
assert.equal(semantic.applied, 4);
console.log('Built-in semantic recognizers: OK');
