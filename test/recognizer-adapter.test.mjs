import assert from 'node:assert/strict';
import { applyRecognizers } from '../src/recognizers.js';

const pages = [[{ type: 'math', text: 'x + y', bbox: { x0: 0, y0: 0, x1: 20, y1: 10 } }]];
const result = await applyRecognizers(pages, [{ name: 'latex', types: ['formula'], recognize: ({ block }) => ({ text: `\\frac{${block.text}}{1}`, confidence: 0.97 }) }]);
assert.equal(result.applied, 1);
assert.equal(pages[0][0].text, '\\frac{x + y}{1}');
assert.equal(pages[0][0].prov, 'recognizer:latex');
assert.equal(result.failures.length, 0);
console.log('Recognizer adapter: OK');
