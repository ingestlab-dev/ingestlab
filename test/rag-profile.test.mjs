import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IngestLab } from '../src/index.js';
import { emitBlocks } from '../src/markdown.js';
import { rankRagChunks, toRagBlocks, toRagChunks } from '../src/rag.js';

const form = (header, rows, info) => ({
  type: 'table', form: true, tagged: true, rows: [header, ...rows], formRows: [null, ...info],
});
const field = { hasField: true, hasValueField: true };
const choice = { hasField: true, hasValueField: false };
const plain = { hasField: false, hasValueField: false };
const ordinaryTable = {
  type: 'table',
  rows: [['Field or instruction', 'Value'], ['Literal ...', '1.25']],
};
const contextualTable = {
  type: 'table',
  sources: [{ page: 1, blockIndex: 0 }],
  rows: [
    ['Line', 'Description', 'Value'],
    ['12a', 'Filing status', ''],
    ['', 'Standard deduction for Single, $15,750', ''],
    ['', 'Standard deduction for Head of household, $23,625', ''],
    ['12e', 'Standard deduction or itemized deductions', ''],
  ],
};
const blocks = toRagBlocks([[
  { type: 'heading', level: 2, text: 'Example' },
  ordinaryTable,
  form(['Field or instruction', 'Value'], [
    ['External reference ...', ''],
    ['Given name', 'Ada'],
    ['Phone number', ''],
    ['\u2611 Yes', ''],
    ['\u2610 No', ''],
    ['\u2611 Fill in details', 'Specified value'],
  ], [plain, field, field, choice, choice, field]),
  form(['Line', 'Description', 'Value'], [
    ['1a', 'Tax amount . .', '1.25'],
    ['', 'Unknown instruction ...', 'Do not discard this value'],
    ['1b', 'Other amount ...', '3.40'],
  ], [{ ...field, x: 90 }, { ...plain, x: 30 }, { ...field, x: 90 }]),
  { type: 'paragraph', text: 'This singular paragraph continues across the next page' },
], [
  { type: 'paragraph', text: 'without breaking its source references.' },
  { type: 'code', lines: ['a ... b . .'] },
]]);
const markdown = emitBlocks(blocks);
assert.match(markdown, /> External reference \.\.\./);
assert.match(markdown, /\*\*Given name:\*\* Ada/);
assert.match(markdown, /\*\*Phone number:\*\*/);
assert.match(markdown, /- \[x\] Yes\n\n- \[ \] No/);
assert.match(markdown, /\[x\] Fill in details.*Specified value/);
assert.match(markdown, /\| 1a \| Tax amount \| 1\.25 \|/);
assert.match(markdown, /\|  \| Unknown instruction \.\.\. \| Do not discard this value \|/);
assert.match(markdown, /\| 1b \| Other amount \.\.\. \| 3\.40 \|/);
assert.match(markdown, /\| Literal \.\.\. \| 1\.25 \|/);
assert.match(markdown, /a \.\.\. b \. \./);
const contextualChunk = toRagChunks([contextualTable], { windowed: false })
  .find(({ text }) => text.includes('Head of household'));
assert.match(contextualChunk.searchText, /12e.*Standard deduction or itemized deductions/s);
assert.match(contextualChunk.text, /\|  \| Standard deduction for Head of household, \$23,625 \|/);
const ranked = rankRagChunks([
  { id: 'noise', text: 'A chart has a value of 0.5', section: ['Charts'], searchText: 'A chart has a value of 0.5', sources: [] },
  { id: 'target', text: '| SR | Slew rate | G = + 1 | 0.5 | V/μs |', section: ['Electrical Characteristics: LM358B'], searchText: 'Electrical Characteristics: LM358B\n| SR | Slew rate | G = + 1 | 0.5 | V/μs | slew rate gain unity gain plus one volts per microsecond', sources: [] },
], 'What is the typical LM358B slew rate with a gain of +1?', { limit: 1 });
assert.equal(ranked[0].id, 'target');
const continued = toRagChunks(blocks).find(({ text }) => text.includes('source references'));
assert.deepEqual(continued.sources, [{ page: 1, blockIndex: 4 }, { page: 2, blockIndex: 0 }]);
assert.match(continued.id, /^p1-b4/);

const dir = process.env.INGESTLAB_PDF_DIR || fileURLToPath(new URL('../../pdf', import.meta.url));
const official = join(dir, 'f1040 (1).pdf');
const master = join(dir, 'Form 1040 (2025) - Clean Master Test Fixture.pdf');
if (existsSync(official) && existsSync(master)) {
  const lab = await IngestLab.init();
  const options = { ocr: false, semanticHtml: true, cache: true, dropHeadersFooters: false };
  const bytes = readFileSync(official);
  const initial = await lab.parse(bytes, options);
  const rag = await lab.parse(bytes, { ...options, markdownProfile: 'rag' });
  const cachedRag = await lab.parse(bytes, { ...options, markdownProfile: 'rag' });
  const faithful = await lab.parse(bytes, { ...options, markdownProfile: 'faithful' });
  assert.equal(cachedRag.fromCache, true);
  assert.deepEqual(cachedRag.ragChunks, rag.ragChunks);
  assert.equal(faithful.markdown, initial.markdown);
  assert.equal(faithful.richMarkdown, initial.richMarkdown);
  assert.equal(faithful.ragChunks, undefined);
  assert.deepEqual(rag.controls, faithful.controls);
  const ingested = await lab.ingest(new Blob([bytes]), { ...options, markdownProfile: 'rag' });
  assert.deepEqual(ingested.ragChunks, rag.ragChunks);
  assert.equal(rag.markdown.match(/\[[ x]\]/g).length, faithful.markdown.match(/\[[ x]\]/g).length);
  assert.doesNotMatch(rag.markdown, /Field or instruction/);
  assert.match(rag.markdown, /\| 1a \| Total amount/);
  assert.doesNotMatch(rag.markdown, /\|  \| (?:Attach Sch\. B|Standard deduction for)/);
  assert.ok(rag.ragChunks.some(({ text }) => text.includes('| 2a | Tax-exempt interest |') &&
    text.includes('Attach Sch. B if required.')));
  const deduction = rag.ragChunks.find(({ text }) => text.includes('$31,500'));
  assert.match(deduction.text, /\| 12e \|.*[\s\S]+\$15,750[\s\S]+\$31,500[\s\S]+\$23,625/);
  assert.deepEqual(deduction.section.slice(-1), ['Tax and Credits']);
  assert.ok(deduction.sources.length >= 6);
  assert.ok(deduction.sources.some(({ rowIndex }) => rowIndex === 16));
  assert.ok(deduction.sources.every(({ page }) => page === 2));
  assert.match(rag.markdown, /\| 12a \| Someone can claim \[ \] You as a dependent \[ \] Your spouse as a dependent \|/);
  assert.ok(rag.ragChunks.every(({ id, searchText }) => id && searchText));
  assert.doesNotMatch(rag.markdown, /\*\*\[ \] (?:Single|Married|Head of household)/);
  assert.match(rag.markdown, /### Presidential Election Campaign[\s\S]*- \[ \] You/);
  const grid = await lab.parse(readFileSync(master), { ...options, markdownProfile: 'rag' });
  assert.match(grid.markdown, /\| Section \| Dependent Field \| Dependent 1/);
  assert.match(grid.richMarkdown, /rowspan=/);
  assert.ok(grid.ragChunks.some(({ text }) => text.includes('Dependent Field') && text.includes('Dependent 4')));
  for (const result of [rag, grid]) {
    for (const { sources } of result.ragChunks) {
      assert.ok(sources.length);
      for (const { page, blockIndex, rowIndex } of sources) {
        const block = result.pages[page - 1]?.[blockIndex];
        assert.ok(block, 'Invalid PDF block reference');
        if (rowIndex !== undefined) assert.ok(block.rows?.[rowIndex], 'Invalid PDF row reference');
      }
    }
  }
} else {
  console.log('PDF form fixtures absent; skipping RAG integration checks');
}
console.log('RAG profile normalization: OK');
