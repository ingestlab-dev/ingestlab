
import { cluster1d, mean } from './util.js';
import { detectRuledTables, detectSemiRuledTables, findBorderlessTable, BULLET_RE, ORDERED_RE } from './tables.js';
import { extractFormBlocks, looksLikeFormPage } from './forms.js';
import { extractLookupTables } from './lookupTables.js';
import { isMathLine, toMathText, isMathFont } from './math.js';

function structHeadingFor(pageCtx, line) {
  const internals = pageCtx.internals;
  if (!internals) return null;
  const norm = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^[#*>\s]+/, '')
      .replace(/^(\d+(\.\d+)*[.)]?\s+|[a-z][.)]\s+|\(?\d+\)?\s+)/, '')
      .replace(/\s+$/, '')
      .trim();
  const lt = norm(line.text);
  if (!lt || lt.length > 120) return null;
  for (const r of internals.structRoles || []) {
    if (/^H[1-6]$/.test(r.role) && norm(r.text) === lt) return { level: +r.role[1], layer: 'structTree' };
  }
  for (const a of internals.outlineAnchors || []) {
    const at = norm(a.title);
    if (at.length >= 4 && (at === lt || (lt.startsWith(at) && lt.length <= at.length + 12) || (at.startsWith(lt) && lt.length >= 8))) {
      // Reserve H1 for the title; top-level outline entries start at H2.
      return { level: Math.min(4, (a.depth || 0) + 2), layer: 'outline' };
    }
  }
  return null;
}

export function groupLines(words, vSegs = [], width = Infinity) {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines = [];
  let cur = null;
  for (let wi = 0; wi < sorted.length; wi++) {
    const w = sorted[wi];
    const sizeJump = w.size <= 0.45 * cur?.maxSize || w.size >= 1.8 * cur?.maxSize;
    const bigPrefix =
      cur &&
      cur.words.length <= 3 &&
      cur.minSize >= 1.15 * w.size &&
      w.x0 - cur.maxX >= 1.4 * w.size;
    // A large gap and a font-size change can mark a column break.
    const sizeDis = !!cur && (w.size >= 1.25 * cur.maxSize || w.size <= 0.78 * cur.minSize);
    const fwdGap = cur && w.x0 - cur.maxX >= 2.2 * Math.max(w.size, cur.maxSize);
    const backGap = cur && cur.minX - w.x1 >= 1.2 * Math.max(w.size, cur.minSize);
    const sameOcrLine = w.ocrLine !== undefined && cur?.words.every((other) => other.ocrLine === w.ocrLine);
    if (!cur || (!sameOcrLine &&
      (Math.abs(w.y - cur.y) > Math.max(2.2, 0.45 * w.size) || sizeJump || bigPrefix || (sizeDis && (fwdGap || backGap))))) {
      cur = { words: [], y: w.y, maxSize: w.size, minSize: w.size, maxX: w.x1, minX: w.x0 };
      lines.push(cur);
    }
    cur.words.push(w);
    cur.maxSize = Math.max(cur.maxSize, w.size);
    cur.minSize = Math.min(cur.minSize, w.size);
    cur.maxX = Math.max(cur.maxX, w.x1);
    cur.minX = Math.min(cur.minX, w.x0);
    cur.y += (w.y - cur.y) / cur.words.length;
  }
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0);
    line.x0 = line.words[0].x0;
    line.x1 = Math.max(...line.words.map((w) => w.x1));
    line.size = Math.max(...line.words.map((w) => w.size));
    line.mono = line.words.every((w) => w.mono);
    line.text = joinLineText(line);
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const script = lines[i];
    const base = lines[i + 1];
    const dy = base.y - script.y;
    if (dy < 0.25 * base.size || dy > 0.8 * base.size || script.words.length > 8 ||
        !isMathLine(base) || script.words.some((w) =>
          w.size > 0.9 * base.size || !/^[A-Za-z0-9+-]{1,3}$/.test(w.str) ||
          !base.words.some((b) => Math.abs(w.x0 - b.x1) < 0.16 * base.size))) continue;
    base.words.push(...script.words);
    base.words.sort((a, b) => a.x0 - b.x0);
    base.text = joinLineText(base);
    lines.splice(i--, 1);
  }
  const merged = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      line.words.length <= 3 &&
      line.words.every((w) => {
        const t = w.str.trim();
        return t.length <= 3 && /^[A-Za-z0-9\u2212\u2013+,.()]+$/.test(t);
      }) &&
      Math.abs(line.y - prev.y) <= 1.2 * line.size
    ) {
      prev.words.push(...line.words);
      prev.x1 = Math.max(prev.x1, line.x1);
      prev.size = Math.max(prev.size, line.size);
      prev.text = joinLineText(prev);
      continue;
    }
    merged.push(line);
  }
  return merged;
}

function joinLineText(line) {
  const words = line.words;
  if (words.length && words[0].ocrLine !== undefined && words.every((w) => w.ocrLine === words[0].ocrLine) &&
      words.some((w) => /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(w.str))) {
    return words.slice().sort((a, b) => a.ocrOrder - b.ocrOrder).map((w) => w.str.trim()).join(' ');
  }
  const base = line.y;
  let out = '';
  let prev = null;
  for (const w of line.words) {
    const t = w.str.trim();
    if (!t) continue;
    if (prev) {
      const gap = w.x0 - prev.x1;
      const shift = w.y - base;
      const script =
        Math.abs(shift) >= 0.28 * w.size &&
        t.length <= 3 &&
        /^[A-Za-z0-9\u2212\u2013+]+$/.test(t) &&
        !SCRIPT_STOPWORDS.has(t.toLowerCase()) &&
        gap < 0.4 * w.size;
      if (script) {
        out += shift < 0 ? '^' + t : '_' + t;
        prev = w;
        continue;
      }
      const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(out) &&
        /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t) && gap < 0.6 * w.size;
      const glueable = eastAsian ||
        /[\d).,;:%\]/−–-]$/.test(out) || /^[\d($[{\/−–-]/.test(t);
      const spaced = gap >= 0.25 * Math.max(prev.size, w.size);
      if (!eastAsian && (spaced || !glueable)) out += ' ';
    }
    out += t;
    prev = w;
  }
  return out;
}

const snap = (v) => Math.round(v * 2) / 2;

// Don't turn offset prose into subscripts or superscripts.
const SCRIPT_STOPWORDS = new Set([
  'if', 'of', 'in', 'on', 'is', 'it', 'to', 'do', 'no', 'or', 'and', 'the', 'for', 'are', 'was', 'you', 'out', 'not', 'all', 'can', 'has', 'its', 'did', 'per', 'via', 'am', 'at', 'as', 'be', 'by', 'we', 'he', 'she', 'his', 'her', 'may', 'yes',
  'là', 'của', 'và', 'các', 'có', 'cho', 'không', 'được', 'năm', 'tháng', 'ngày', 'theo', 'tại', 'với', 'một', 'những',
]);

// Vietnamese legal headings often use the same font size as body text.
const LEGAL_RE = [
  { re: /^(CHƯƠNG|Chương)\s+([IVXLĐCM]+|\d{1,3})\b/, level: 2 },
  { re: /^(Mục|MỤC)\s+\d{1,3}\b/, level: 3 },
  { re: /^(Điều|ĐIỀU)\s+\d{1,3}\b\.?/, level: 3 },
];

export function legalHeadingLevel(text) {
  if (text.length > 110) return 0;
  for (const { re, level } of LEGAL_RE) if (re.test(text)) return level;
  return 0;
}

export function headingPlausible(text) {
  const t = text.trim();
  if (!t) return false;
  if (/^\d{1,2}(\.\d{1,2})*\s+\S/.test(t)) return true;
  if (/^\d{4}\b/.test(t) && t.split(/\s+/).length <= 8 && !/\.$/.test(t)) return true;
  const words = t.split(/\s+/);
  const noPunct = !/[.,;:!?…]$/.test(t);
  if (/[a-z,;:…]$/.test(t)) {
    return words.length <= 6 && noPunct && /^[A-Z"“(\[\d]/.test(t);
  }
  if (words.length <= 2 && t.length <= 18 && !/\d/.test(t) && /^[A-Z"'“(\[]/.test(t)) return true;
  return (noPunct || /[)”"'\]]$/.test(t)) && !/\d$/.test(t);
}

export function numberedHeadingLevel(text) {
  const t = text.trim();
  if (/\.$/.test(t)) return 0;
  const m = t.match(/^(\d{1,2}(?:\.\d{1,2}){1,2})\s+[A-Z"“(\[]/);
  if (m && !m[1].startsWith('0') && t.split(/\s+/).length <= 10) return m[1].split('.').length === 2 ? 3 : 4;
  if (/^\d{1,2}\s+[A-Z"“(\[]/.test(t) && t.split(/\s+/).length <= 8 && t.trim().length >= 10) return 2;
  return 0;
}

export function headingJunk(text) {
  const s = String(text || '').trim();
  if ((s.match(/[A-Za-z0-9]/g) || []).length < 2) return true;
  if (/[*|]/.test(s)) return true;
  if (/\d,\d{3}/.test(s) && /^[\d.,\s]+$/.test(s)) return true;
  if (/[$\u20ac\u00a3\u00a5]\s*\d{1,3}([.,]\d{3})+/.test(s)) return true;
  const n = s.length;
  for (let L = 3; L <= 40 && L <= n / 2; L++) {
    const f = s.slice(0, L);
    const k = Math.floor(n / L);
    if (k >= 2 && s.startsWith(f.repeat(k)) && f.startsWith(s.slice(f.length * k))) return true;
  }
  return false;
}

export function headingPlausibleForm(text) {
  const t = text.trim();
  if (!t) return false;
  if (/\bwww\.|https?:/i.test(t)) return false;
  if (/[)\]]$/.test(t)) return false;
  if (/[☐☑☒○◉]/.test(t)) return false;
  if (/\d{2,}/.test(t.replace(/\(\d{4}\)/g, ''))) return false;
  const words = t.split(/\s+/);
  if (words.length > 8) return false;
  if (words.length === 1 && /^[A-Z][a-z]+$/.test(t) && t.length <= 12) return false;
  return true;
}

// Use full-width content to split the page before reading each column.
function columnOrder(lines, width, consumedMap) {
  const WIDE = 0.75 * width;
  const isVisualMarker = (l) => !!(l._figure || l._imgNote || l._caption);
  const isWide = (l) => isVisualMarker(l) ? (l.x1 - l.x0 >= WIDE) : (l.x1 - l.x0 >= WIDE || consumedMap.has(l));
  // Infer columns from text, then place figures and captions in the same order.
  const body = lines.filter((l) => !isVisualMarker(l) && !isWide(l));
  if (body.length < 6) return null;

  const ivs = body.map((l) => [l.x0, l.x1]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of ivs) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const minGutter = Math.max(10, 0.05 * width);
  const cuts = [];
  for (let i = 1; i < merged.length; i++) {
    if (merged[i][0] - merged[i - 1][1] >= minGutter) cuts.push((merged[i][0] + merged[i - 1][1]) / 2);
  }
  if (cuts.length === 0 || cuts.length > 3) return null;

  const columnForX = (x) => {
    for (let i = 0; i < cuts.length; i++) if (x < cuts[i]) return i;
    return cuts.length;
  };
  const colIdx = (l) => columnForX((l.x0 + l.x1) / 2);
  const perCol = new Array(cuts.length + 1).fill(0);
  for (const l of body) perCol[colIdx(l)]++;
  if (perCol.some((n) => n > 0 && n < 4)) return null;

  const ordered = [];
  let band = [];
  const flushBand = () => {
    if (!band.length) return;
    const groups = new Map();
    for (const l of band) {
      const ci = isVisualMarker(l) ? columnForX(l.x0) : colIdx(l);
      if (!groups.has(ci)) groups.set(ci, []);
      groups.get(ci).push(l);
    }
    for (const [ci, ls] of [...groups].sort((a, b) => a[0] - b[0])) {
      const colL = ci === 0 ? 0 : cuts[ci - 1];
      const colR = ci === cuts.length ? width : cuts[ci];
      for (const l of ls) if (!l._figure) l._cw = colR - colL;
      ls.sort((x, y) => x.y - y.y || x.x0 - y.x0);
      ordered.push(...ls);
    }
    band = [];
  };
  for (const l of [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    if (isWide(l)) {
      flushBand();
      ordered.push(l);
    } else {
      band.push(l);
    }
  }
  flushBand();
  return ordered.length === lines.length ? ordered : null;
}

export function computeDocScale(allLines) {
  const freq = new Map();
  for (const l of allLines) {
    const s = snap(l.size);
    freq.set(s, (freq.get(s) || 0) + l.words.length);
  }
  let body = 0;
  let best = -1;
  for (const [s, n] of freq) {
    if (n > best || (n === best && s > body)) {
      body = s;
      best = n;
    }
  }
  // Use size ratios so extra table fonts don't demote the document title.
  const headingLevels = new Map();
  for (const s of freq.keys()) {
    const r = s / body;
    let lvl = 0;
    if (r >= 1.6) lvl = 1;
    else if (r >= 1.32) lvl = 2;
    else if (r >= 1.16) lvl = 3;
    if (lvl) headingLevels.set(s, lvl);
  }
  return { body, headingLevels };
}

function codeText(run) {
  const x0 = Math.min(...run.map((l) => l.x0));
  const size = Math.max(1e-6, mean(run.map((l) => l.size)));
  return run.map((l) => {
    const charW = 0.6 * size;
    let out = ' '.repeat(Math.max(0, Math.round((l.x0 - x0) / charW)));
    let prev = null;
    for (const w of l.words) {
      if (prev) out += ' '.repeat(Math.max(1, Math.round((w.x0 - prev.x1) / charW)));
      out += w.str;
      prev = w;
    }
    return out.replace(/\s+$/, '');
  });
}

// Join section labels wrapped down the left margin.
function mergeStackedRail(lines, width) {
  const isRail = (l) => l.x0 < 0.1 * width && l.x1 < 0.24 * width;
  const isShort = (l) => l.words.length <= 2 && l.text.trim().length <= 20;
  const out = [];
  let lastRail = null;
  for (const l of lines) {
    if (
      lastRail &&
      isRail(l) &&
      isShort(l) &&
      Math.abs(l.x0 - lastRail.x0) <= 5 &&
      l.y - lastRail.y > 0 &&
      l.y - lastRail.y <= 1.45 * Math.max(l.size, lastRail.size) &&
      Math.max(l.size, lastRail.size) <= 1.25 * Math.min(l.size, lastRail.size)
    ) {
      lastRail.text = (lastRail.text + ' ' + l.text).trim();
      lastRail.words.push(...l.words);
      lastRail.x1 = Math.max(lastRail.x1, l.x1);
      lastRail.y = l.y;
      lastRail.size = Math.max(lastRail.size, l.size);
      continue;
    }
    l._rail = isRail(l) && isShort(l);
    if (l._rail) lastRail = l;
    out.push(l);
  }
  return out;
}

export function buildPageLayout(pageCtx, scale, opts = {}) {
  const { borderless: detectBorderless = true } = opts;
  const { segments, words, width, height, fills } = pageCtx;
  const lookupTables = extractLookupTables(pageCtx);
  const lookupWords = new Set(lookupTables.flatMap((t) => [...t.consumed]));
  const blocks = [];

  // Let worksheets claim line items before the table detector on form pages.
  const formPage = looksLikeFormPage(pageCtx);
  const panels = (pageCtx.figures || []).filter((f) => f.bbox.sourcePanel);
  const captionedFigures = (pageCtx.figures || []).filter((f) => f.bbox.sourcePanel || f.bbox.circuit);
  const inPanel = (l) => panels.some(({ bbox: p }) => l.x0 >= p.x0 - 2 && l.x1 <= p.x1 + 2 && l.y >= p.y0 && l.y <= p.y1 + 2);
  const mainLines = pageCtx.lines.filter((l) => !inPanel(l)).flatMap((l) => {
    const rest = l.words.filter((w) => !lookupWords.has(w));
    return rest.length === l.words.length ? [l] : groupLines(rest, segments.v, width);
  });
  const pageLines = formPage ? mergeStackedRail(mainLines, width) : mainLines;
  // Scans need a wider tolerance for fragmented rules.
  const segTol = pageCtx.fills?.length || pageCtx.curves?.length || pageCtx.primitives?.length ? 4 : 14;
  let ruled;
  let formBlocks;
  if (formPage) {
    formBlocks = extractFormBlocks(pageCtx, pageLines, [], true);
    const wsBoxes = formBlocks.filter((b) => b.type === 'worksheet').map((b) => b.bbox);
    ruled = [...detectRuledTables(words, segments, width, height, { tol: segTol }), ...detectSemiRuledTables(words, segments, width, height, { tol: segTol })].filter((t) => {
      const area = (t.bbox.x1 - t.bbox.x0) * (t.bbox.y1 - t.bbox.y0);
      return !wsBoxes.some((wb) => {
        const ox = Math.max(0, Math.min(t.bbox.x1, wb.x1) - Math.max(t.bbox.x0, wb.x0));
        const oy = Math.max(0, Math.min(t.bbox.y1, wb.y1) - Math.max(t.bbox.y0, wb.y0));
        return (ox * oy) / Math.max(1, area) > 0.35;
      });
    });
  } else {
    ruled = [...detectRuledTables(words, segments, width, height, { tol: segTol }), ...detectSemiRuledTables(words, segments, width, height, { tol: segTol })];
    formBlocks = [];
  }
  const overlapsLookup = (b) => b && lookupTables.some(({ bbox: a }) =>
    Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) + 3 && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0) + 3);
  ruled = ruled.filter(({ bbox: b }) => !inPanel({ ...b, y: (b.y0 + b.y1) / 2 }) && !overlapsLookup(b));
  const consumedMap = new Map();
  for (const l of pageLines) {
    const cx = (l.x0 + l.x1) / 2;
    const cy = l.y;
    for (const t of ruled) {
      if (cx > t.bbox.x0 - 2 && cx < t.bbox.x1 + 2 && cy > t.bbox.y0 - 2 && cy < t.bbox.y1 + 2) {
        // Keep boxed section tabs separate from the table beside them.
        if (l.x0 <= t.bbox.x0 + 14 && l.x1 - l.x0 <= 120 && l.words.length <= 4) continue;
        consumedMap.set(l, t);
        break;
      }
    }
  }

  if (!formPage) {
    try {
      formBlocks = extractFormBlocks(pageCtx, pageCtx.lines, ruled.map((t) => t.bbox));
    } catch {
    }
  }
  const formMap = new Map();
  formBlocks = formBlocks.filter(({ bbox }) => !overlapsLookup(bbox));
  for (const fb of formBlocks) {
    for (const l of pageLines) {
      const cx = (l.x0 + l.x1) / 2;
      if (cx >= fb.bbox.x0 - 2 && cx <= fb.bbox.x1 + 2 && l.y >= fb.bbox.y0 - 2 && l.y <= fb.bbox.y1 + 2) {
        formMap.set(l, fb);
      }
    }
  }

  // Place figures without claiming their labels or axis ticks.
  const figs = (pageCtx.figures || []).slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  const imgNotes = [];
  for (const im of pageCtx.images || []) {
    const w = im.x1 - im.x0;
    const h = im.y1 - im.y0;
    if (w <= 0 || h <= 0) continue;
    const isFullPage = w * h >= 0.85 * width * height;
    imgNotes.push({
      _imgNote: true,
      bbox: { x0: im.x0, y0: im.y0, x1: im.x1, y1: im.y1 },
      text: isFullPage
        ? `[Full-page image ${Math.round(w)}×${Math.round(h)}]`
        : `[Image region ${Math.round(w)}×${Math.round(h)}]`,
      x0: im.x0,
      x1: im.x1,
      y: im.y0,
      size: 9,
      words: [],
    });
  }

  const captionRe = /^(?:figure|fig\.?|hình|sơ đồ|biểu đồ|chart|graph|diagram)\s+\d+(?:\.\d+)*\s*(?:[:–-]|\.\s)/i;
  const isPanelCaption = (line) => captionedFigures.some(({ bbox }) => line.text === bbox.caption &&
    line.y >= bbox.y1 - 32 && line.y <= bbox.y1 + (bbox.circuit ? 40 : 26));
  const isCaption = (line) => !consumedMap.has(line) && captionRe.test(String(line.text || '').trim());
  const captionLines = pageLines.filter((line) => !isPanelCaption(line) && isCaption(line));
  const contentLines = pageLines.filter((line) => !isPanelCaption(line) && !isCaption(line));
  const captionMarkers = captionLines.map((line) => ({
    _caption: true,
    caption: String(line.text || '').trim(),
    x0: line.x0,
    x1: line.x1,
    y: line.y,
    size: 1,
    words: [],
    text: '',
  }));
  const visualMarkers = [
    ...figs.map((fig) => ({ _figure: fig, x0: fig.bbox.x0, x1: fig.bbox.x1, y: fig.bbox.y0, size: 1, words: [], text: '' })),
    ...imgNotes.map((note) => ({ ...note, _imgNote: true })),
    ...captionMarkers,
  ];
  const ordered = columnOrder([...contentLines, ...visualMarkers].sort((a, b) => a.y - b.y || a.x0 - b.x0), width, consumedMap);
  const lines = ordered || [...contentLines, ...visualMarkers].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lookupOrder = [...lookupTables].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  for (let i = 0; i < lookupOrder.length;) {
    const start = lookupOrder[i].bbox.y0;
    let end = i + 1;
    while (end < lookupOrder.length && lookupOrder[end].bbox.y0 - start <= 30) end++;
    const band = lookupOrder.slice(i, end).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    lookupOrder.splice(i, end - i, ...band);
    i = end;
  }
  let lastLookupIndex = -1;
  for (const table of lookupOrder) {
    const { consumed, ...block } = table;
    const index = lines.findIndex((l, i) => i > lastLookupIndex && l.y >= table.bbox.y0);
    lastLookupIndex = index < 0 ? lines.length : index;
    lines.splice(lastLookupIndex, 0, { _lookup: block, x0: table.bbox.x0, y: table.bbox.y0 });
  }
  const rotated = (pageCtx.rotated || []).filter((r) => r.str.trim().length >= 3 && Math.abs(r.angle) > 0.5);
  const rotLines = [];
  for (const r of rotated) {
    const margin = r.x0 < 0.1 * width || r.x1 > 0.92 * width;
    const inFigure = (pageCtx.figures || []).some(
      (f) => r.y >= f.bbox.y0 - 14 && r.y <= f.bbox.y1 + 14 && r.x0 + r.x1 >= 2 * f.bbox.x0 - 30 && r.x0 + r.x1 <= 2 * f.bbox.x1 + 30
    );
    rotLines.push({ ...r, _inFig: inFigure });
  }
  rotLines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const rotMerged = [];
  for (const r of rotLines) {
    const last = rotMerged[rotMerged.length - 1];
    if (last && Math.abs(r.x0 - last.x0) < 3 * r.size && r.y - last._y <= 2.6 * r.size) {
      last.text += ' ' + r.str;
      last._y = r.y;
    } else {
      rotMerged.push({
        _rotated: true,
        _inFig: r._inFig,
        text: r.str,
        x0: r.x0,
        x1: r.x1,
        y: r.y,
        size: r.size,
        words: [],
        _y: r.y,
      });
    }
  }
  for (const rm of rotMerged) {
    const idx = lines.findIndex((l) => l.y > rm.y);
    if (idx < 0) lines.push(rm);
    else lines.splice(idx, 0, rm);
  }
  let pending = [];
  let listRun = null;
  let codeRun = null;

  const emitFigure = (fig) => {
    flushPending();
    flushList();
    flushCode();
    if (fig._caption) {
      blocks.push({
        type: 'figure',
        kind: 'caption',
        caption: fig.caption,
        prov: 'pdfCaption',
        bboxW: Math.round(fig.x1 - fig.x0),
        bboxH: 1,
      });
      return;
    }
    const w = Math.round(fig.bbox.x1 - fig.bbox.x0);
    const h = Math.round(fig.bbox.y1 - fig.bbox.y0);
    blocks.push({
      type: 'figure',
      kind: fig.kind2 || fig.kind || null,
      mermaid: fig.mermaid || null,
      svg: fig.svg || null,
      prov: fig.mermaid ? 'mermaidSynthesis' : undefined,
      tableMd: fig.tableMd || null,
      reconstruction: fig.reconstruction,
      visualContent: fig.visualContent,
      approximateValues: Boolean(fig.data?.approximateColumns),
      bbox: fig.bbox,
      sourceText: fig.bbox.sourcePanel ? pageCtx.lines.filter((l) =>
        l.x0 >= fig.bbox.x0 - 2 && l.x1 <= fig.bbox.x1 + 2 && l.y >= fig.bbox.y0 && l.y <= fig.bbox.y1 + 2 &&
        l.text !== fig.bbox.caption).map((l) => l.text).join('\n') : undefined,
      omitSourceText: Boolean(fig.bbox.axisBars || fig.bbox.standaloneFlow),
      sourceCaption: fig.bbox.caption,
      bboxW: w,
      bboxH: h,
    });
  };
  const flushPending = () => {
    if (!pending.length) return;
    const run = pending;
    pending = [];
    // Detect tables before formulas so numeric rows stay in the grid.
    const sectionLead = /^[\p{L}]+\s+\d+(?:\.\d+)*\s*\([^)]{1,40}\):\s+\p{L}/u.test(run[0].text);
    const bt = detectBorderless && !sectionLead ? findBorderlessTable(run) : null;
    if (bt) {
      blocks.push({ type: 'table', kind: 'borderless', rows: bt.rows, prov: 'plumberGrid' });
      return;
    }
    const seq = [];
    for (const line of run) {
      const last = seq[seq.length - 1];
      if (isMathLine(line)) {
        if (last && last.math) last.lines.push(line);
        else seq.push({ math: true, lines: [line] });
      } else {
        if (last && !last.math) last.lines.push(line);
        else seq.push({ math: false, lines: [line] });
      }
    }
    for (const seg of seq) {
      if (seg.math) {
        blocks.push({ type: 'math', text: buildMathText(seg.lines), prov: seg.lines.some((l) => l.words.some((w) => isMathFont(w.font))) ? 'texMath' : 'geometricFallback' });
      } else {
        emitParagraphs(seg.lines);
      }
    }
  };

  const buildMathText = (mathLines) => {
    const out = [];
    const usedBar = new Set();
    for (let i = 0; i < mathLines.length; i++) {
      const num = mathLines[i];
      const den = mathLines[i + 1];
      const bar = (segments?.h || []).find(
        (s, si) =>
          !usedBar.has(si) &&
          s.to - s.from < 0.6 * width &&
          s.to - s.from > 8 &&
          s.pos > num.y + 1 &&
          den &&
          s.pos < den.y - 1 &&
          s.pos - num.y < 2.2 * num.size &&
          den.y - s.pos < 2.2 * den.size &&
          s.from >= num.x0 - 6 &&
          s.to <= num.x1 + 6
      );
      if (bar) {
        usedBar.add((segments?.h || []).indexOf(bar));
        out.push(`\\frac{${toMathText(num)}}{${toMathText(den)}}`);
        i++;
      } else {
        out.push(toMathText(num));
      }
    }
    return out.join('\n');
  };

  const emitParagraphs = (run) => {
    // Start a new paragraph after a font-size change or a short line.
    const paras = [];
    let curP = null;
    for (const line of run) {
      if (!curP) {
        curP = { lines: [line] };
        continue;
      }
      const prev = curP.lines[curP.lines.length - 1];
      const gapY = line.y - prev.y;
      const sizeJump =
        line.size >= 1.35 * prev.size || line.size <= 0.72 * prev.size;
      const colW = line._cw || width - 2 * Math.min(72, prev.x0);
      const prevFull = prev.x1 - prev.x0 >= 0.55 * colW;
      if (!sizeJump && gapY <= 1.75 * prev.size && prevFull) curP.lines.push(line);
      else {
        paras.push(curP);
        curP = { lines: [line] };
      }
    }
    paras.push(curP);
    for (const p of paras) {
      let text = '';
      p.lines.forEach((line, idx) => {
        const t = line.text;
        if (idx === 0) text = t;
        else if (text.endsWith('-') && /^[a-zà-öø-ÿ]/.test(t)) text = text.slice(0, -1) + t;
        else text += ' ' + t;
      });
      const l0 = p.lines[0];
      const lN = p.lines[p.lines.length - 1];
      const blockW = Math.max(l0.x1, lN.x1) - l0.x0;
      const paraH = lN.y - l0.y + 1.5 * (l0.size || 10);
      const isChrome = (f) => (f.x1 - f.x0) * (f.y1 - f.y0) >= 0.6 * width * height;
      const co =
        (fills || []).some(
          (f) =>
            f.x0 <= l0.x0 + 2 &&
            f.x1 >= Math.max(l0.x1, lN.x1) - 2 &&
            f.y0 <= l0.y - 1 &&
            f.y1 >= lN.y + 1 &&
            (f.x1 - f.x0) * (f.y1 - f.y0) >= 2500 &&
            f.y1 - f.y0 <= 1.6 * paraH &&
            (!formPage || f.x1 - f.x0 <= 0.5 * width) &&
            !isChrome(f)
        ) ||
        // On forms, a nearby left rule can be a table border.
        (!formPage &&
          (segments.v || []).some(
            (sg) =>
              sg.pos >= l0.x0 - 8 &&
              sg.pos <= l0.x0 + 2 &&
              sg.from <= l0.y - 2 &&
              sg.to >= lN.y + 2 &&
              sg.to - sg.from >= 0.7 * paraH &&
              sg.to - sg.from <= 1.5 * paraH &&
              blockW >= 60
          ));
      blocks.push({
        type: co ? 'aside' : 'paragraph',
        text,
        prov: co ? 'callout' : p.lines.some((l) => l._cw) ? 'xyCut' : undefined,
        _y1: p.lines[p.lines.length - 1].y,
      });
    }
  };

  const flushList = () => {
    if (!listRun) return;
    const items = listRun;
    listRun = null;
    const baseX = Math.min(...items.map((l) => l.x0));
    blocks.push({
      type: 'list',
      items: items.map((l) => {
        const orderedMatch = l.text.match(ORDERED_RE);
        const ordered = !!orderedMatch;
        const text = l.text.replace(BULLET_RE, '').replace(ORDERED_RE, '').trimStart();
        const nested = l.x0 - baseX > 1.2 * l.size;
        return { text, ordered, nested, marker: orderedMatch ? orderedMatch[1] : null };
      }),
      _y1: Math.max(...items.map((l) => l.y)),
    });
  };

  const flushCode = () => {
    if (!codeRun) return;
    const run = codeRun;
    codeRun = null;
    if (run.length >= 2) blocks.push({ type: 'code', lines: codeText(run), _y1: run[run.length - 1].y });
    else pending.push(...run);
  };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]._lookup) {
      flushPending();
      flushList();
      flushCode();
      blocks.push(lines[i]._lookup);
      continue;
    }
    const line = lines[i];
    if (line._caption) {
      emitFigure(line);
      continue;
    }
    if (line._figure) {
      emitFigure(line._figure);
      continue;
    }
    if (line._rotated) {
      flushPending();
      flushList();
      flushCode();
      const edgeBanner =
        (line.x1 > 0.955 * width || line.x1 < 0.05 * width) && line.text.length <= 26 && !line._inFig;
      const okHeading = !line._inFig && (!formPage || headingPlausibleForm(line.text));
      blocks.push(
        edgeBanner
          ? { type: 'aside', text: line.text }
          : okHeading && !headingJunk(line.text)
            ? { type: 'heading', level: 2, text: line.text }
            : { type: 'paragraph', text: line.text }
      );
      continue;
    }

    if (line._imgNote) {
      flushPending();
      flushList();
      flushCode();
      blocks.push({ type: 'image', text: line.text, bbox: line.bbox });
      continue;
    }

    const ruledTable = consumedMap.get(line);
    if (ruledTable) {
      flushPending();
      flushList();
      flushCode();
      const t = ruledTable;
      // A table can be encountered again after an intervening prose line.
      if (!t._emitted) {
        t._emitted = true;
        blocks.push({
          type: 'table',
          kind: 'ruled',
          rows: t.rows,
          spans: t.spans,
          meta: t.meta,
          prov: 'plumberGrid',
        });
      }
      continue;
    }

    const formBlock = formMap.get(line);
    if (formBlock) {
      flushPending();
      flushList();
      flushCode();
      if (!formBlock._emitted) {
        formBlock._emitted = true;
        blocks.push({ ...formBlock, bbox: undefined });
      }
      continue;
    }

    // Prefer tagged headings and outline entries over font sizes.
    const structHeading = structHeadingFor(pageCtx, line);
    if (structHeading && !headingJunk(line.text)) {
      flushPending();
      flushList();
      flushCode();
      blocks.push({ type: 'heading', level: structHeading.level, text: line.text, prov: structHeading.layer, _y: line.y });
      continue;
    }

    const lvl = scale.headingLevels.get(snap(line.size));
    const plausible = headingPlausible(line.text) && (!formPage || headingPlausibleForm(line.text));
    const railLabel =
      formPage &&
      line.x0 < 0.12 * width &&
      line.size >= 1.2 * scale.body &&
      Math.min(...line.words.map((x) => x.size)) >= 1.05 * scale.body &&
      /[A-Za-z]{2}/.test(line.text) &&
      !/[.,;:!?]$/.test(line.text) &&
      line.words.length <= 3 &&
      line.text.length <= 24;
    const displayType = lvl === 1 && snap(line.size) >= 2.6 * scale.body;
    if (lvl && !headingJunk(line.text) && line.words.length <= 18 && line.text.length <= 100 && (displayType || plausible || railLabel)) {
      flushPending();
      flushList();
      flushCode();
      const last = blocks[blocks.length - 1];
      const mergedText = `${last?.text || ''} ${line.text}`.trim();
      if (
        last &&
        last.type === 'heading' &&
        last.level === lvl &&
        !headingJunk(mergedText) &&
        Math.abs(line.y - (last._y || 0)) <= 2.4 * line.size
      ) {
        last.text = mergedText.slice(0, 160);
        last._y = line.y;
      } else {
        blocks.push({ type: 'heading', level: lvl, text: line.text, prov: 'geometricFallback', _y: line.y });
      }
      continue;
    }

    if (!lvl && line.words.length <= 14 && !headingJunk(line.text)) {
      const legal = legalHeadingLevel(line.text);
      if (legal) {
        flushPending();
        flushList();
        flushCode();
        blocks.push({ type: 'heading', level: legal, text: line.text });
        continue;
      }
    }

    if (!lvl && line.words.length <= 10 && !headingJunk(line.text)) {
      const nlvl = numberedHeadingLevel(line.text);
      if (nlvl) {
        flushPending();
        flushList();
        flushCode();
        blocks.push({ type: 'heading', level: nlvl, text: line.text });
        continue;
      }
    }

    if (BULLET_RE.test(line.text) || ORDERED_RE.test(line.text)) {
      flushPending();
      flushCode();
      const ordered = ORDERED_RE.test(line.text);
      if (listRun && listRun[0].isOrdered !== ordered) flushList();
      listRun ||= [];
      line.isOrdered = ordered;
      listRun.push(line);
      continue;
    }

    if (line.mono) {
      flushPending();
      flushList();
      if (codeRun && line.y - codeRun[codeRun.length - 1].y > 3 * line.size) flushCode();
      codeRun ||= [];
      codeRun.push(line);
      continue;
    }

    flushList();
    flushCode();
    // Don't split a table run just because row spacing is wider than prose.
    pending.push(line);
  }
  flushPending();
  flushList();
  flushCode();
  return blocks;
}
