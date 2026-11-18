import { partitionComponents } from './tables.js';

const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
const inside = (b, a, t = 1) => b.x0 >= a.x0 - t && b.x1 <= a.x1 + t && b.y0 >= a.y0 - t && b.y1 <= a.y1 + t;
const center = (w) => [w.x0 / 2 + w.x1 / 2, w.y - w.size * 0.29];
const checkbox = /^[\u2610\u2611\u2612\u25cb\u25c9]$/u;
const integer = /^\d+(?:,\d{3})*$/;

function axes(rules, limits, minimum) {
  const out = [];
  for (const s of rules.filter((s) => s.to - s.from >= minimum).sort((a, b) => a.pos - b.pos)) {
    const axis = out.at(-1);
    if (axis && s.pos - axis.pos <= 1.6) axis.rules.push(s);
    else out.push({ pos: s.pos, rules: [s] });
  }
  return out.filter(({ pos }) => pos >= limits[0] - 1 && pos <= limits[1] + 1);
}

function crosses(axis, from, to, minCoverage = 0.8) {
  const intervals = axis.rules.map((s) => [Math.max(from, s.from), Math.min(to, s.to)])
    .filter(([a, b]) => a < b).sort(([a], [b]) => a - b);
  let covered = 0, last = from;
  for (const [a, b] of intervals) {
    covered += Math.max(0, b - Math.max(a, last));
    last = Math.max(last, b);
  }
  return covered >= (to - from) * minCoverage;
}

function at(axes, point) {
  for (let i = 0; i + 1 < axes.length; i++) if (point >= axes[i].pos && point < axes[i + 1].pos) return i;
  return -1;
}

function cellText(words, width) {
  const bands = [];
  for (const w of words.slice().sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = bands.at(-1);
    if (last && Math.abs(last.y - w.y) <= Math.max(1.3, w.size * 0.28)) last.words.push(w);
    else bands.push({ y: w.y, words: [w] });
  }
  const lines = bands.map((b) => b.words.sort((a, b) => a.x0 - b.x0).map((w) => w.str).join(' '));
  const sep = width < 37 && lines.length > 1 && lines.every((s) => /^[\p{L}\p{N}/\u2013-]+$/u.test(s)) ? '' : ' ';
  return lines.join(sep).replace(/\[_{3,}\]|_{3,}/g, '').replace(/(?:\s+\.){3,}\s*$/, '')
    .replace(/(\p{L})-\s+(?=[\p{Ll}\p{N}])/gu, '$1-').replace(/\s+([,;])/g, '$1')
    .replace(/\s{2,}/g, ' ').trim();
}

function readGrid(component, page) {
  const { bbox: b } = component, w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < page.width * 0.27 || h < 28 || area(b) > page.width * page.height * 0.91 ||
      b.y0 < 2 || b.x0 < 2) return null;
  const fills = page.fills.filter((f) => f.isRect && inside(f.bbox, b) &&
    f.bbox.x1 - f.bbox.x0 > 14 && f.bbox.y1 - f.bbox.y0 > 8);
  const xs = axes(component.v, [b.x0, b.x1], 10);
  const ys = axes(component.h, [b.y0, b.y1], 10);
  const cols = xs.length - 1, count = ys.length - 1;
  if (fills.length < (cols === 1 && count >= 3 ? 1 : 3)) return null;
  if (cols < 1 || cols > 14 || count < 2 || count > 85 ||
      !crosses(ys[0], b.x0, b.x1) || !crosses(xs[0], b.y0, b.y1)) return null;
  const rightClosed = crosses(xs.at(-1), b.y0, b.y1);
  const bottomClosed = crosses(ys.at(-1), b.x0, b.x1, 0.8);
  // A continuation row may stop before the last column.
  if (!(rightClosed && crosses(ys.at(-1), b.x0, b.x1, 0.15)) &&
      !(bottomClosed && crosses(xs.at(-1), ys[0].pos, ys[1].pos))) return null;
  const words = page.words.filter((word) => {
    const [x, y] = center(word);
    return at(xs, x) >= 0 && at(ys, y) >= 0;
  });
  const wordRows = Array.from({ length: count }, () => []);
  for (const word of words) wordRows[at(ys, center(word)[1])].push(word);
  const numericRows = new Set();
  if (cols >= 4) for (let r = 1; r < count; r++) {
    const ws = wordRows[r];
    if (ws.length !== cols || ws.some((word) => !integer.test(word.str))) continue;
    if (new Set(ws.map((word) => at(xs, center(word)[0]))).size === cols) numericRows.add(r);
  }
  // A header can define numeric columns even when their body rules stop.
  if (numericRows.size < 3) numericRows.clear();
  const rows = Array.from({ length: count }, () => Array(cols).fill(''));
  const owners = rows.map(() => Array(cols).fill(null));
  for (let r = 0; r < count; r++) for (let c = 0; c < cols; c++) {
    if (owners[r][c]) continue;
    let right = c + 1;
    while (right < cols && !numericRows.has(r) && !crosses(xs[right], ys[r].pos, ys[r + 1].pos)) right++;
    let bottom = r + 1;
    while (bottom < count && !numericRows.has(bottom) &&
      !Array.from({ length: right - c }, (_, i) => c + i)
        .some((k) => crosses(ys[bottom], xs[k].pos, xs[k + 1].pos, 0.55)) &&
      (c === 0 || crosses(xs[c], ys[bottom].pos, ys[bottom + 1].pos)) &&
      (right === cols || crosses(xs[right], ys[bottom].pos, ys[bottom + 1].pos)) &&
      Array.from({ length: right - c - 1 }, (_, i) => c + i + 1)
        .every((k) => !crosses(xs[k], ys[bottom].pos, ys[bottom + 1].pos))) bottom++;
    const cell = { r, c, rowspan: bottom - r, colspan: right - c, words: [] };
    for (let y = r; y < bottom; y++) for (let x = c; x < right; x++) {
      if (owners[y][x]) return null;
      owners[y][x] = cell;
    }
  }
  for (const word of words) {
    const [x, y] = center(word);
    owners[at(ys, y)][at(xs, x)].words.push(word);
  }
  const cells = new Set(owners.flat());
  for (const cell of cells) rows[cell.r][cell.c] = cellText(cell.words,
    xs[cell.c + cell.colspan].pos - xs[cell.c].pos);
  if (rows.flat().filter(Boolean).length < (cols === 1 ? 1 : 2)) return null;
  const spans = [...cells].filter((c) => c.rowspan > 1 || c.colspan > 1)
    .map(({ r, c, rowspan, colspan }) => ({ r, c, rowspan, colspan }));
  const crossesFirst = spans.some((s) => s.r === 0 && s.rowspan === 2);
  const tiers = crossesFirst || (spans.some((s) => s.r === 0 && s.colspan > 1) && rows[1]?.filter(Boolean).length >= 3) ? 2 : 1;
  const groupRows = spans.filter((s) => s.r >= tiers && s.c === 0 && s.colspan === cols && s.rowspan === 1 &&
    rows[s.r][0]).map((s) => s.r);
  return { type: 'table', kind: 'ruled', bbox: b, rows, spans, meta: { headerRows: tiers, groupRows },
    keepColumns: true, form: true, words };
}

export function extractFormGrids(page) {
  if (page.ocr || page.annotations.length || page.fills.length < 18 || page.rotated.length > 3 ||
      page.images.some((b) => area(b) > page.width * page.height * 0.04)) return [];
  const checkboxWords = page.words.filter((w) => checkbox.test(w.str));
  const combs = page.primitives.filter((p) => p.type === 'comb');
  const isSlot = (b) => combs.some(({ bbox: c }) => inside(b, c, 1.4));
  const comb = new Set(checkboxWords.filter((w) => isSlot({
    x0: w.x0, x1: w.x1, y0: w.y - w.size, y1: w.y,
  })));
  const sorted = checkboxWords.slice().sort((a, b) => a.x0 - b.x0);
  for (const start of sorted) {
    const run = [start];
    for (const next of sorted) {
      const prev = run.at(-1), gap = next.x0 - prev.x1;
      if (next.x0 > prev.x0 + 2 && gap >= -1.5 && gap < 1.8 && Math.abs(next.y - start.y) < 1.3 &&
          Math.abs(next.size - start.size) < 1.8) run.push(next);
    }
    if (run.length >= 2) for (const word of run) comb.add(word);
  }
  const words = page.words.filter((word) => !comb.has(word) && !(word.str === '-' &&
    combs.some(({ bbox: b }) => word.y > b.y0 && word.y < b.y1 + 2 &&
      (Math.abs(word.x0 - b.x1) < 7 || Math.abs(word.x1 - b.x0) < 7))));
  const grids = partitionComponents(page.segments, 1).map((c) => readGrid(c, { ...page, words })).filter(Boolean)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const claimed = new Set();
  for (const g of grids) for (const word of g.words) {
    if (claimed.has(word)) return [];
    claimed.add(word);
  }
  if (grids.length < 2 || claimed.size < words.length * 0.78) return [];
  const boxes = [];
  for (const box of page.formBoxes) {
    if (isSlot(box.bbox) || [...comb].some((w) =>
      Math.abs(w.x0 - box.bbox.x0) < 1.2 && Math.abs(w.y - box.bbox.y1) < 1.2)) continue;
    if (!boxes.some((other) => inside(box.bbox, other.bbox) && inside(other.bbox, box.bbox))) boxes.push(box);
  }
  page.formBoxes = boxes;
  const elements = grids.map(({ words, ...grid }) => grid);
  const bands = [];
  for (const word of words.filter((w) => !claimed.has(w)).sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = bands.at(-1);
    if (last && Math.abs(last.y - word.y) <= 2) last.words.push(word);
    else bands.push({ y: word.y, words: [word] });
  }
  const headings = new Map();
  for (const { y, words } of bands) {
    const text = cellText(words, page.width);
    if (!text) continue;
    const x0 = Math.min(...words.map((w) => w.x0)), x1 = Math.max(...words.map((w) => w.x1));
    const banner = page.fills.find((f) => f.isRect && f.bbox.x1 - f.bbox.x0 >= page.width * 0.65 &&
      f.bbox.y1 - f.bbox.y0 < 40 && inside({ x0, x1, y0: y - 2, y1: y }, f.bbox));
    if (banner && headings.has(banner)) headings.get(banner).text += ' ' + text;
    else {
      const block = banner ? { type: 'heading', level: 2, text, bbox: banner.bbox } :
        { type: 'paragraph', text, bbox: { x0, x1, y0: y - 2, y1: y } };
      elements.push(block);
      if (banner) headings.set(banner, block);
    }
  }
  return elements.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}
