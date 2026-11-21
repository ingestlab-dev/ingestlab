import { normalizeMath } from './math.js';

const RECOGNIZABLE = new Set([
  'formula', 'figure', 'chart', 'diagram', 'form_field', 'checkbox', 'ocr_low_confidence',
]);

const CHEMICAL_ARROW = /(?:<=>|⇌|↔|→|←|=>|->|<-)/;
const CHEMICAL_TOKEN = /\b(?:[A-Z][a-z]?)(?:[₀₁₂₃₄₅₆₇₈₉0-9]+)?/g;

function textOf(block) {
  return String(block?.text || block?.sourceText || '').replace(/\s+/g, ' ').trim();
}

function markdownTable(rows) {
  if (!rows.length) return null;
  const escape = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return ['| Category | Value |', '| --- | ---: |', ...rows.map(([label, value]) => `| ${escape(label)} | ${escape(value)} |`)].join('\n');
}

function chartRows(block) {
  const fromData = block?.data?.rows || block?.chartData?.rows || block?.rows;
  if (Array.isArray(fromData)) {
    const rows = fromData
      .map((row) => Array.isArray(row) ? row : [row?.label ?? row?.category, row?.value])
      .map((row) => [String(row?.[0] ?? '').trim(), String(row?.[1] ?? '').trim()])
      .filter(([label, value]) => label && value);
    if (rows.length) return { rows, confidence: 0.94, source: 'structured' };
  }
  const source = String(block?.text || block?.sourceText || '').replace(/\r/g, '').trim();
  if (!source) return null;
  const rows = [];
  for (const line of source.split(/\n|;(?=\s*[A-Za-z])/)) {
    const match = line.trim().match(/^(.+?)\s*[,=:|\t]\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:%|\s*%?)?)\s*$/);
    if (match) rows.push([match[1].trim(), match[2].trim()]);
  }
  return rows.length >= 2 ? { rows, confidence: 0.72, source: 'text' } : null;
}

function chartMermaid(rows, kind = 'bar') {
  const labels = rows.map(([label]) => JSON.stringify(label.replace(/"/g, '\\"'))).join(', ');
  const values = rows.map(([, value]) => {
    const n = Number.parseFloat(String(value).replace(/%/g, ''));
    return Number.isFinite(n) ? String(n) : '0';
  }).join(', ');
  const mark = /line|trend|series/i.test(kind) ? 'line' : 'bar';
  return ['xychart-beta', `  x-axis [${labels}]`, '  y-axis "Value" 0 -->', `  ${mark} [${values}]`].join('\n');
}

function formulaLatex(raw) {
  let text = normalizeMath(String(raw || '')
    .replace(/[“”]/g, '"').replace(/[′’]/g, "'")
    .replace(/−/g, '-').replace(/∞/g, '\\infty')
    .replace(/≤/g, '\\leq ').replace(/≥/g, '\\geq ')
    .replace(/≠/g, '\\ne ').replace(/≈/g, '\\approx ')
    .replace(/×/g, '\\times ').replace(/÷/g, '\\div ')
    .replace(/√\s*([A-Za-z0-9]+)/g, '\\sqrt{$1}'));
  text = text.replace(/\b([A-Za-z0-9])\s*\/\s*([A-Za-z0-9])\b/g, '\\frac{$1}{$2}');
  text = text.replace(/([A-Za-z])_([A-Za-z0-9])\b/g, '$1_{$2}');
  text = text.replace(/([A-Za-z])\^([A-Za-z0-9])\b/g, '$1^{$2}');
  return text;
}

function chemicalEquation(raw) {
  const source = String(raw || '').replace(/[−–—]/g, '-').replace(/⇢|⟶/g, '→').trim();
  const arrow = source.match(CHEMICAL_ARROW);
  if (!arrow) return null;
  const sides = source.split(CHEMICAL_ARROW).map((side) => side.trim()).filter(Boolean);
  if (sides.length !== 2) return null;
  const tokens = source.match(CHEMICAL_TOKEN) || [];
  if (tokens.length < 3) return null;
  const normalized = source.replace(/\s*(<=>|⇌|↔|→|←|=>|->|<-|⇢|⟶)\s*/g, ' -> ')
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/\s+/g, ' ').trim();
  return `\\ce{${normalized}}`;
}

/** Create an opt-in deterministic formula recognizer using the existing PDF text geometry. */
export function createFormulaRecognizer() {
  return {
    name: 'formula-latex',
    types: ['formula'],
    recognize({ block }) {
  const source = String(block?.text || block?.sourceText || '').trim();
      if (!source) return null;
      const latex = formulaLatex(source);
      if (!latex || !/[=+\-*/^_\\]|\\(?:frac|sqrt|times|leq|geq)/.test(latex)) return null;
      return {
        text: latex,
        latex,
        formula: { source, format: 'latex' },
        confidence: block.prov === 'texMath' ? 0.98 : 0.82,
        prov: 'recognizer:formula-latex',
      };
    },
  };
}

/** Create an opt-in mhchem recognizer for text-layer chemical equations. */
export function createChemistryRecognizer() {
  return {
    name: 'chemistry-mhchem',
    types: ['formula', 'paragraph'],
    recognize({ block }) {
      const source = textOf(block);
      const latex = chemicalEquation(source);
      if (!latex) return null;
      return {
        text: latex,
        latex,
        chemistry: { source, format: 'mhchem' },
        confidence: 0.86,
        prov: 'recognizer:chemistry-mhchem',
      };
    },
  };
}

/** Create an opt-in chart recognizer that promotes extracted rows to Markdown and Mermaid data. */
export function createChartRecognizer() {
  return {
    name: 'chart-data',
    types: ['chart', 'figure'],
    recognize({ block }) {
      const parsed = chartRows(block);
      if (!parsed) return null;
      const kind = block.kind2 || block.kind || 'bar';
      const rows = parsed.rows;
      const data = { ...(block.data || {}), rows, source: parsed.source };
      return {
        data,
        chartData: { kind, rows, source: parsed.source },
        tableMd: block.tableMd || markdownTable(rows),
        mermaid: block.mermaid || (rows.length <= 30 ? chartMermaid(rows, kind) : null),
        confidence: parsed.confidence,
        prov: 'recognizer:chart-data',
      };
    },
  };
}

/**
 * Create a handwriting hook. Without a supplied model it only marks low-confidence
 * regions as candidates and preserves source text. A model adapter may return fields
 * such as `text`, `confidence`, or `handwriting` from the same callback contract.
 */
export function createHandwritingRecognizer({ recognize } = {}) {
  return {
    name: 'handwriting-hook',
    types: ['ocr_low_confidence', 'form_field', 'figure'],
    async recognizeBlock(context) {
      if (typeof recognize === 'function') return recognize(context);
      const { block, pageData } = context;
      const confidence = block.confidence ?? pageData?.ocrConfidence ?? 0;
      const candidate = block.handwritten === true || block.kind === 'handwriting' || confidence < 0.45;
      if (!candidate) return null;
      return {
        handwriting: { candidate: true, recognized: false, reason: 'no handwriting model configured' },
        confidence: Math.max(0, Math.min(1, confidence)),
        prov: 'recognizer:handwriting-hook',
      };
    },
    recognize(context) {
      return this.recognizeBlock(context);
    },
  };
}

function blockType(block, page) {
  if (page?.ocr && (page.ocrConfidence ?? 1) < 0.7) return 'ocr_low_confidence';
  if (block.type === 'math') return 'formula';
  if (block.type === 'figure' && ['chart'].includes(block.kind || block.kind2)) return 'chart';
  if (block.type === 'figure' && ['diagram', 'schematic', 'circuit'].includes(block.kind)) return 'diagram';
  if (block.type === 'field' || block.type === 'form_line' || block.type === 'form_field') return 'form_field';
  if (block.type === 'form_choice') return 'checkbox';
  return block.type;
}

function matches(recognizer, type) {
  const types = recognizer.types || recognizer.type;
  if (!types) return RECOGNIZABLE.has(type);
  return Array.isArray(types) ? types.includes(type) : types === type;
}

export async function applyRecognizers(pages, recognizers = [], context = {}) {
  if (!recognizers?.length) return { applied: 0, failures: [] };
  let applied = 0;
  const failures = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    for (let blockIndex = 0; blockIndex < page.length; blockIndex++) {
      const block = page[blockIndex];
      const type = blockType(block, context.pageData?.[pageIndex]);
      for (const recognizer of recognizers) {
        if (!recognizer || typeof recognizer.recognize !== 'function' || !matches(recognizer, type)) continue;
        try {
          const result = await recognizer.recognize({
            block,
            type,
            page: pageIndex + 1,
            blockIndex,
            pageData: context.pageData?.[pageIndex],
            document: context.document,
          });
          if (!result || typeof result !== 'object') continue;
          Object.assign(block, result);
          block.recognizer = recognizer.name || recognizer.id || 'custom';
          block.recognizerConfidence = result.confidence ?? block.confidence;
          block.prov = result.prov || `recognizer:${block.recognizer}`;
          applied++;
        } catch (error) {
          failures.push({ page: pageIndex + 1, blockIndex, type, recognizer: recognizer.name || recognizer.id || 'custom', error: String(error?.message || error) });
        }
      }
    }
  }
  return { applied, failures };
}
