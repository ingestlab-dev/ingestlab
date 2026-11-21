import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IngestLab } from '../src/index.js';

const lab = await IngestLab.init();
const input = await readFile('test/fixtures/visual-printed.pdf');
const pages = [];
const result = await lab.parse(input, {
  cache: false,
  ocr: false,
  figures: false,
  onPage: (event) => pages.push({ page: event.page, count: event.blocks.length }),
});
assert.deepEqual(pages.map(({ page }) => page), [1, 2]);
assert.equal(result.pages.length, pages.length);
console.log('Page streaming callback: OK');
