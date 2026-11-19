import { emitBlocks } from './markdown.js';

const checkbox = /[\u2610\u2611\u2612\u25cb\u25c9]/u;
const startsWithCheckbox = /^[\u2610\u2611\u2612\u25cb\u25c9]/u;
const SEARCH_ALIASES = [
  [/\bHOH\b/iu, 'head of household'],
  [/\bMFJ\b/iu, 'married filing jointly'],
  [/\bMFS\b/iu, 'married filing separately'],
  [/\bQSS\b/iu, 'qualifying surviving spouse'],
  [/\bSR\b/iu, 'slew rate'],
  [/\bGBW\b/iu, 'gain bandwidth product'],
  [/\bSSN\b/iu, 'social security number'],
  [/\btyp\b/iu, 'typ typical'],
  [/\bmin\b/iu, 'minimum'],
  [/\bmax\b/iu, 'maximum'],
  [/\bG\s*=\s*\+?\s*1\b/iu, 'gain unity gain plus one'],
  [/\bV\s*\/\s*μs\b/iu, 'volts per microsecond'],
  [/\bV\s*\/\s*us\b/iu, 'volts per microsecond'],
];
const SEARCH_STOP_WORDS = new Set('a an and are as at be can did do for from how i if in is it many may much of on or select should the to was what were where which with you'.split(' '));
const QUERY_EXPANSIONS = [
  [/\b(?:alternative|additional) documents?\b/iu, 'also attach forms w 2g 1099 r'],
  [/\bbank account types?\b/iu, 'checking savings'],
  [/\bparallel attention heads?\b/iu, 'parallel attention layers'],
  [/\b(?:compare|compared) with\b/iu, 'nearly identical'],
];
const cleanDescription = (text) => text
  .replace(/\s+/gu, ' ')
  .replace(/(?:\s+\.){2,}(?=\s*(?:$|[\u2610\u2611\u2612\u25cb\u25c9]))/gu, '')
  .replace(/\s+\.(?=\s*$)/u, '')
  .trimEnd();

function rowSource(block, index) {
  return { ...block.sources[0], rowIndex: index };
}

function joinParagraphText(left, right) {
  if (left.endsWith('-') && /^\p{Ll}/u.test(right)) return left.slice(0, -1) + right;
  return `${left} ${right}`.replace(/\s+/gu, ' ').trim();
}

function coalesceParagraphs(blocks) {
  const out = [];
  for (const block of blocks) {
    const previous = out.at(-1);
    if (previous?.type === 'paragraph' && block.type === 'paragraph') {
      previous.text = joinParagraphText(previous.text, block.text);
      previous._y1 = block._y1 ?? previous._y1;
      if (previous.sources && block.sources) previous.sources.push(...block.sources);
      continue;
    }
    out.push({ ...block });
  }
  return out;
}

function formFields(block) {
  return block.rows.slice(1).map(([description, value], i) => {
    const { hasField, hasValueField } = block.formRows[i + 1];
    const sources = [rowSource(block, i + 1)];
    const text = cleanDescription(description);
    if (checkbox.test(text) && !String(value || '').trim())
      return { type: 'form_choice', text, sources };
    if (hasValueField || value) return { type: 'field', label: text, value, sources };
    return { type: hasField ? 'form_choice' : 'instruction', text, sources };
  });
}

function chunkId(sources, suffix = '') {
  const first = sources[0];
  if (!first) return undefined;
  const base = `p${first.page}-b${first.blockIndex}` +
    (first.rowIndex === undefined ? '' : `-r${first.rowIndex}`);
  return suffix ? `${base}-${suffix}` : base;
}

function searchText(section, text) {
  const value = [...(section || []), text].join('\n');
  const aliases = SEARCH_ALIASES.filter(([pattern]) => pattern.test(value)).map(([, alias]) => alias);
  return aliases.length ? `${value}\n${aliases.join(' ')}` : value;
}

const searchTokens = (text) => text.normalize('NFKC').toLowerCase()
  .match(/[\p{L}\p{N}]+/gu) || [];

/**
 * Rank generated RAG chunks with a small deterministic BM25 index. Phrase and
 * section matches receive a bounded boost so repeated numeric values in a
 * datasheet do not outrank the table that names the requested parameter.
 */
export function rankRagChunks(chunks, query, { limit = 20 } = {}) {
  const expandedQuery = [query, ...QUERY_EXPANSIONS.filter(([pattern]) => pattern.test(query)).map(([, value]) => value)].join(' ');
  const queryWords = [...new Set(searchTokens(expandedQuery))].filter((word) => !SEARCH_STOP_WORDS.has(word));
  const identityWords = queryWords.filter((word) => /[a-z]/u.test(word) && /\d/u.test(word) && word.length >= 3);
  const queryBigrams = queryWords.slice(0, -1).map((word, i) => `${word} ${queryWords[i + 1]}`);
  const docs = chunks.map((chunk, index) => {
    const indexed = chunk.searchText || searchText(chunk.section, chunk.text);
    const words = searchTokens(indexed);
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    return { chunk, index, indexed: indexed.toLowerCase(), words, counts };
  });
  const meanLength = docs.reduce((sum, doc) => sum + doc.words.length, 0) / Math.max(1, docs.length);
  const frequencies = new Map();
  for (const doc of docs) for (const word of doc.counts.keys())
    frequencies.set(word, (frequencies.get(word) || 0) + 1);
  const ranked = docs.map((doc) => {
    const score = queryWords.reduce((total, word) => {
      const tf = doc.counts.get(word);
      if (!tf) return total;
      const df = frequencies.get(word) || 0;
      const idf = Math.log1p((docs.length - df + 0.5) / (df + 0.5));
      return total + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.words.length / meanLength));
    }, 0);
    const phraseBoost = queryBigrams.reduce((total, phrase) =>
      doc.indexed.includes(phrase) ? total + 3.5 : total, 0);
    const sectionText = (doc.chunk.section || []).join(' ').toLowerCase();
    const sectionBoost = queryWords.reduce((total, word) =>
      sectionText.includes(word) ? total + 0.35 : total, 0);
    const finalSection = (doc.chunk.section || []).at(-1)?.toLowerCase() || '';
    const identityMatches = identityWords.filter((word) => doc.indexed.includes(word)).length;
    const finalIdentityMatches = identityWords.filter((word) => finalSection.includes(word)).length;
    const identityBoost = identityWords.length
      ? finalIdentityMatches * 10 + (identityMatches - finalIdentityMatches) * 2 - (identityMatches ? 0 : 6)
      : 0;
    const numberPositions = doc.words.flatMap((word, index) => /^\d+(?:\.\d+)?$/u.test(word) ? [index] : []);
    const conceptPositions = queryWords.flatMap((word) => {
      const positions = [];
      doc.words.forEach((value, index) => { if (value === word) positions.push(index); });
      return positions;
    });
    const numericQuestion = /(?:how much|how many|amount|value|rate|range)/iu.test(query);
    const nearbyNumberBoost = numericQuestion &&
      numberPositions.some((number) => conceptPositions.some((concept) => Math.abs(number - concept) <= 8))
      ? (/\bhow many\b/iu.test(query) ? 8 : 4) : 0;
    const directCountBoost = /\bhow many\b/iu.test(query) &&
      /\b\d+\s+parallel\b/iu.test(doc.indexed) ? 12 : 0;
    const comparisonBoost = /\b(?:compare|compared|difference|versus)\b/iu.test(query) && doc.chunk.kind !== 'table' ? 5 : 0;
    const exactQueryBoost = doc.indexed.includes(query.trim().toLowerCase()) ? 8 : 0;
    return { chunk: doc.chunk, score: score + phraseBoost + sectionBoost + identityBoost + nearbyNumberBoost + directCountBoost + comparisonBoost + exactQueryBoost, index: doc.index };
  });
  return ranked.filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}

function marginNotes(block, rows) {
  const columns = rows.filter((row) => /^(?:\d{1,2}[a-z]?)$/i.test(row.cells[0]) && row.info.hasValueField)
    .map((row) => row.info.x).filter(Number.isFinite).sort((a, b) => a - b);
  if (columns.length < 2) return [];
  const left = columns[Math.floor(columns.length / 2)];
  const isMargin = ({ cells: [line, text, value], info }) =>
    !line && text && !value && !info.hasField && info.x < left - 14;
  const notes = [];
  for (let i = 0; i < rows.length; i++) {
    if (!isMargin(rows[i])) continue;
    const first = rows[i];
    const group = [first];
    while (i + 1 < rows.length && isMargin(rows[i + 1])) group.push(rows[++i]);
    const next = rows[i + 1];
    const line = next?.cells[0];
    const nearby = next && /^\d{1,2}[a-z]?$/i.test(line) &&
      Math.abs(next.info.y - first.info.y) <= 23 && next.info.x > first.info.x + 14;
    const explicit = nearby && group.some(({ cells }) => cells[1].split(/\s+/).includes(line));
    const heading = first.cells[1].match(/^([\p{L}]+ [\p{L}]+)\b/u)?.[1];
    const sameTopic = nearby && heading && next.cells[1].toLowerCase().startsWith(heading.toLowerCase() + ' ');
    const nextY = Math.abs(next?.info.y - first.info.y);
    const aligned = nearby && nextY <= 18;
    const sharedCode = nearby && (first.cells[1].match(/\b[A-Z]{3,}\b|\b[A-Z]-\d+\b/g) || [])
      .some((code) => next.cells[1].split(/[^\w-]+/).includes(code));
    const linked = explicit || sameTopic || aligned || sharedCode;
    notes.push({
      type: 'instruction',
      text: group.map(({ cells }) => cells[1]).join('\n'),
      ...(linked ? { line, targetRowIndex: next.index } : {}),
      sources: group.map(({ index }) => rowSource(block, index)),
    });
  }
  return notes;
}

function amountTable(block) {
  const rows = block.rows.slice(1).map(([line, description, value], i) => ({
    cells: [line, cleanDescription(description), value],
    index: i + 1,
    info: block.formRows[i + 1],
  }));
  const notes = marginNotes(block, rows);
  const moved = new Set(notes.flatMap(({ sources }) => sources.map(({ rowIndex }) => rowIndex)));
  const data = [];
  for (const row of rows) {
    if (moved.has(row.index)) continue;
    const prev = data.at(-1);
    if (prev && prev.lastIndex + 1 === row.index && prev.cells[0] && prev.info &&
        !prev.info.hasValueField && !prev.cells[2] &&
        !row.cells[0] && !row.cells[2] && row.info.hasField && !row.info.hasValueField &&
        startsWithCheckbox.test(row.cells[1])) {
      prev.cells[1] += ' ' + row.cells[1];
      prev.lastIndex = row.index;
      prev.sources.push(rowSource(block, row.index));
    } else {
      data.push({ ...row, lastIndex: row.index, sources: [rowSource(block, row.index)] });
    }
  }
  if (!data.length) return notes;
  return [{
    ...block,
    formRows: undefined,
    rows: [block.rows[0], ...data.map(({ cells }) => cells)],
    rowSources: [[], ...data.map(({ sources }) => sources)],
    notes,
  }];
}

function rewriteForm(block) {
  if (block.type !== 'table' || !block.tagged || !block.form || !block.formRows) return [block];
  return block.rows[0].length === 3 ? amountTable(block) : formFields(block);
}

export function pageOrderedBlocks(pages, withSources = false, { coalesce = true } = {}) {
  const ordered = [];
  let pending = null;
  for (let i = 0; i < pages.length; i++) {
    let blocks = withSources ? pages[i].map((block, blockIndex) => ({
      ...block, sources: [{ page: i + 1, blockIndex, ...(block.bbox && { bbox: block.bbox }) }],
    })) : pages[i];
    if (coalesce) blocks = coalesceParagraphs(blocks);
    if (pending && blocks[0]?.type === 'paragraph') {
      const head = blocks[0].text;
      if (/^\p{Ll}/u.test(head)) {
        const joiner = pending.text.endsWith('-') ? '-' :
          pending.text.length > 40 && !/[.!?:;\u201d"')\]]$/.test(pending.text) ? ' ' : null;
        if (joiner) {
          pending.text = joiner === '-' ? pending.text.slice(0, -1) + head : pending.text + ' ' + head;
          if (withSources) pending.sources = [...pending.sources, ...blocks[0].sources];
          blocks = blocks.slice(1);
        }
      }
    }
    if (pending) ordered.push(pending);
    pending = blocks.at(-1)?.type === 'paragraph' ? { ...blocks.at(-1) } : null;
    for (let index = 0; index < blocks.length - Number(!!pending); index++) ordered.push(blocks[index]);
  }
  if (pending) ordered.push(pending);
  return ordered;
}

export function toRagBlocks(pages) {
  return pageOrderedBlocks(pages, true, { coalesce: false }).flatMap(rewriteForm);
}

function tableChunks(block, { windowed = true } = {}) {
  const headerCount = Math.min(block.meta?.headerRows || 1, block.rows.length);
  const spanOwner = new Map();
  for (const span of block.spans || []) {
    for (let row = span.r + 1; row < span.r + span.rowspan; row++) {
      spanOwner.set(row + ':' + span.c, span.r);
    }
  }
  const dataCount = block.rows.length - headerCount;
  const groupSize = windowed ? (block.form ? 4 : 5) : 1;
  const stride = windowed ? (block.form ? 3 : 4) : 1;
  const windows = [];
  for (let start = 0; start < dataCount; start += stride) {
    const end = Math.min(dataCount, start + groupSize);
    windows.push([headerCount + start, headerCount + end]);
    if (end === dataCount) break;
  }
  const chunks = [];
  for (const [start, end] of windows) {
    const rows = block.rows.slice(start, end);
    const inherited = new Set();
    const outputRows = rows.map((cells, localRow) => cells.map((cell, column) => {
      const i = start + localRow;
      const owner = spanOwner.get(i + ':' + column);
      if (cell || owner === undefined || !block.rows[owner]?.[column]) return cell;
      inherited.add(owner);
      return block.rows[owner][column];
    }));
    if (!outputRows.some((row) => row.some(Boolean))) continue;
    const sources = block.rowSources
      ? block.rowSources.slice(start, end).flat()
      : Array.from({ length: end - start }, (_, offset) => rowSource(block, start + offset));
    const notes = block.notes?.filter((note) =>
      note.targetRowIndex !== undefined && sources.some(({ rowIndex }) => rowIndex === note.targetRowIndex)) || [];
    const table = {
      ...block,
      rows: [...block.rows.slice(0, headerCount), ...outputRows],
      spans: block.spans?.filter((span) => span.r + span.rowspan <= headerCount),
      meta: { ...block.meta, groupRows: [], totalRows: [] },
      notes,
    };
    const contextStart = Math.max(headerCount, start - (windowed ? 1 : 4));
    const contextEnd = Math.min(block.rows.length, end + (windowed ? 1 : 5));
    const indexRows = block.rows.slice(contextStart, contextEnd);
    const contextTable = {
      ...block,
      rows: [...block.rows.slice(0, headerCount), ...indexRows],
      formRows: undefined,
      notes: block.notes?.filter((note) => note.targetRowIndex === undefined ||
        note.targetRowIndex >= contextStart && note.targetRowIndex < contextEnd),
    };
    const contextRows = new Set(inherited);
    if (!block.form || !block.tagged) {
      for (let header = 0; header < headerCount; header++) contextRows.add(header);
    }
    chunks.push({
      text: emitBlocks([table]),
      searchText: emitBlocks([contextTable]),
      sources: [
        ...sources,
        ...Array.from(contextRows, (index) => rowSource(block, index)),
        ...notes.flatMap((note) => note.sources),
      ],
      kind: 'table',
      tableRowRange: { start, end: end - 1 },
      id: chunkId(sources, `r${start}-${end - 1}`),
    });
  }
  if (!chunks.length) {
    const text = emitBlocks([block]);
    chunks.push({ text, sources: block.sources, kind: 'table', id: chunkId(block.sources) });
  }
  else for (const note of block.notes || []) if (note.targetRowIndex === undefined)
    { const text = emitBlocks([note]); chunks.push({ text, sources: note.sources,
      kind: 'instruction', id: chunkId(note.sources) }); }
  return chunks;
}

export function toRagChunks(blocks, options = {}) {
  const headings = [];
  const chunks = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'heading') {
      while (headings.length && headings.at(-1).level >= block.level) headings.pop();
      headings.push(block);
    }
    const section = headings.map(({ text }) => text);
    const parts = [block];
    if (block.type === 'instruction' || block.type === 'form_choice') {
      const { page, blockIndex } = block.sources[0];
      while (blocks[i + 1]?.type === 'form_choice') {
        const next = blocks[i + 1];
        if (next.sources[0].page !== page || next.sources[0].blockIndex !== blockIndex ||
            !startsWithCheckbox.test(next.text)) break;
        parts.push(next);
        i++;
      }
    }
    const rendered = block.type === 'table' ? tableChunks(block, options) : [{
      text: emitBlocks(parts), sources: parts.flatMap(({ sources }) => sources), kind: 'text',
    }];
    for (const { text, sources, kind, tableRowRange, id, searchText: indexedText } of rendered)
      if (text.trim()) chunks.push({
        text, section, searchText: searchText(section, indexedText || text), sources,
        ...(kind && { kind }), ...(tableRowRange && { tableRowRange }),
        id: id || chunkId(sources),
      });
  }
  return chunks;
}
