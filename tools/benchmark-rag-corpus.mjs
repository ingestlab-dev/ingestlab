import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { IngestLab } from '../src/index.js';
import { pageOrderedBlocks, rankRagChunks, toRagChunks } from '../src/rag.js';

const root = resolve(process.argv[2] || '../pdf/corpus-150');
const synthetic = join(root, 'synthetic');
const truth = JSON.parse(await readFile(join(synthetic, 'ground-truth.json'), 'utf8'));
const queries = [];
for (const fixture of truth) {
  if (fixture.variant === 'scan-with-margin') continue;
  for (const [page, expected] of fixture.pages.entries()) for (const table of expected.tables) {
    queries.push({
      file: fixture.file,
      page: page + 1,
      query: `What is ${table.anchor} ${table.rows[2]?.[0] || table.anchor} in the table?`,
      terms: [table.anchor, table.rows[2]?.[0] || table.anchor],
    });
  }
}

function evaluate(passages) {
  const cases = queries.map((query) => {
    const fromSource = (passage) => passage.name === query.file &&
      passage.sources.some(({ page }) => page === query.page);
    const matches = (passage) => {
      const indexedText = (passage.searchText || [...passage.section, passage.text].join('\n')).toLowerCase();
      return fromSource(passage) && query.terms.every((term) => indexedText.includes(term.toLowerCase()));
    };
    const result = rankRagChunks(passages, query.query, { limit: passages.length });
    const rank = result.findIndex(matches) + 1;
    return { rank: rank || null, sourceAt1: !!result[0] && fromSource(result[0]), indexed: passages.some(matches) };
  });
  const average = (fn) => cases.reduce((sum, item) => sum + fn(item), 0) / cases.length;
  return {
    passages: passages.length,
    evidenceCoverage: average(({ indexed }) => Number(indexed)),
    recallAt1: average(({ rank }) => Number(rank === 1)),
    recallAt5: average(({ rank }) => Number(rank > 0 && rank <= 5)),
    mrr: average(({ rank }) => rank ? 1 / rank : 0),
    sourceAccuracyAt1: average(({ sourceAt1 }) => Number(sourceAt1)),
    queries: cases.length,
  };
}

const lab = await IngestLab.init();
const faithful = [];
const rag = [];
for (const name of [...new Set(queries.map(({ file }) => file))]) {
  const bytes = await readFile(join(synthetic, name));
  const options = { cache: false, ocr: false, figures: false, dropHeadersFooters: false };
  const baseline = await lab.parse(bytes, options);
  const rewritten = await lab.parse(bytes, { ...options, markdownProfile: 'rag' });
  faithful.push(...toRagChunks(pageOrderedBlocks(baseline.pages, true), { windowed: false })
    .map(({ searchText, ...passage }) => ({ name, ...passage })));
  rag.push(...rewritten.ragChunks.map((passage) => ({ name, ...passage })));
}
console.log(JSON.stringify({ corpus: 'synthetic-vector', queries: queries.length,
  faithful: evaluate(faithful), rag: evaluate(rag) }, null, 2));
