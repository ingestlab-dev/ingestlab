import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IngestLab } from '../src/index.js';
import { pageOrderedBlocks, rankRagChunks, toRagChunks } from '../src/rag.js';

const dir = process.env.INGESTLAB_PDF_DIR || resolve(process.argv[2] || fileURLToPath(new URL('../../pdf', import.meta.url)));
const form = 'f1040 (1).pdf';
const grid = 'Form 1040 (2025) - Clean Master Test Fixture.pdf';
const paper = '1706.03762v7.pdf';
const datasheet = 'lm358.pdf';
const queries = [
  [form, [2], 'How much is the standard deduction at line 12e for a head of household?', ['12e', 'head of household', '23,625']],
  [form, [2], 'What are the standard deduction amounts for the different filing statuses?', ['15,750', '31,500', '23,625']],
  [form, [2], 'What are both options for someone claiming a dependent on line 12a?', ['12a', 'you as a dependent', 'your spouse as a dependent']],
  [form, [2], 'What bank account types can I select for a refund?', ['type', 'checking', 'savings']],
  [form, [1], 'Do digital asset sales or exchanges require a yes or no response?', ['digital asset', 'sell, exchange', '[ ] yes', '[ ] no']],
  [grid, [2], 'What alternative documents must I attach if tax was withheld?', ['also attach forms w-2g and 1099-r']],
  [form, [2], 'What schedule may be needed for a qualifying child claiming the earned income credit?', ['27a', 'earned income credit', 'attach sch. eic']],
  [form, [1], 'Where should I put my foreign postal code?', ['foreign postal code']],
  [grid, [1], 'Which dependent field records the relationship for the fourth dependent?', ['dependent 4', 'relationship']],
  [grid, [2], 'What is the amount for head of household in the tax and credits grid?', ['23,625', 'head of household']],
  [paper, [4], 'How are queries and keys used in scaled dot-product attention?', ['scaled dot-product attention', 'queries and keys']],
  [paper, [5], 'How many parallel attention heads are used?', ['8 parallel attention layers']],
  [paper, [6], 'How did learned positional embeddings compare with sinusoidal encodings?', ['learned positional embeddings', 'nearly identical']],
  [datasheet, [1], 'What is the wide supply voltage range for the B and BA versions?', ['wide supply range', '3v to 36v']],
  [datasheet, [6, 8], 'What is the typical LM358B slew rate with a gain of +1?', ['lm358b', 'slew rate', '0.5', 'v/μs']],
];

const tokens = (text) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
function evaluate(passages) {
  const cases = queries.map(([name, pages, query, terms]) => {
    const fromSource = (passage) => passage.name === name && passage.sources.some(({ page }) => pages.includes(page));
    const matches = (passage) => {
      const indexedText = (passage.searchText || [...passage.section, passage.text].join('\n')).toLowerCase();
      return fromSource(passage) && terms.every((term) => indexedText.includes(term));
    };
    const results = rankRagChunks(passages, query, { limit: passages.length });
    const rank = results.findIndex(matches) + 1;
    return { query, rank: rank || null, sourceAt1: !!results[0] && fromSource(results[0]), indexed: passages.some(matches) };
  });
  const average = (f) => cases.reduce((sum, item) => sum + f(item), 0) / cases.length;
  return {
    passages: passages.length,
    evidenceCoverage: average(({ indexed }) => Number(indexed)),
    recallAt1: average(({ rank }) => Number(rank === 1)),
    recallAt5: average(({ rank }) => Number(rank > 0 && rank <= 5)),
    mrr: average(({ rank }) => rank ? 1 / rank : 0),
    sourceAccuracyAt1: average(({ sourceAt1 }) => Number(sourceAt1)),
    cases,
  };
}

const lab = await IngestLab.init();
const faithful = [], rag = [];
for (const name of new Set(queries.map(([name]) => name))) {
  const bytes = await readFile(join(dir, name));
  const options = { ocr: false, figures: false, cache: false, dropHeadersFooters: false };
  const baseline = await lab.parse(bytes, options);
  const rewritten = await lab.parse(bytes, { ...options, markdownProfile: 'rag' });
  faithful.push(...toRagChunks(pageOrderedBlocks(baseline.pages, true), { windowed: false })
    .map((passage) => ({ name, ...passage })));
  rag.push(...rewritten.ragChunks.map((passage) => ({ name, ...passage })));
}
console.log(JSON.stringify({ queries: queries.length, faithful: evaluate(faithful), rag: evaluate(rag) }, null, 2));
