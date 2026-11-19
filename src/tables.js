
import { cluster1d, mean } from './util.js';


// Keep side-by-side grids separate by grouping rules that touch.
export function partitionComponents(segments, tol = 4) {
  const H = segments.h || [];
  const V = segments.v || [];
  const n = H.length + V.length;
  if (!n) return [];
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const hi = (i) => i;
  const vi = (j) => H.length + j;

  const Vs = V.map((s, j) => ({ ...s, j })).sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    let lo = 0;
    let hi2 = Vs.length;
    while (lo < hi2) {
      const mid = (lo + hi2) >> 1;
      if (Vs[mid].pos < h.from - tol) lo = mid + 1;
      else hi2 = mid;
    }
    for (let k = lo; k < Vs.length && Vs[k].pos <= h.to + tol; k++) {
      const v = Vs[k];
      if (h.pos >= v.from - tol && h.pos <= v.to + tol) union(hi(i), vi(v.j));
    }
  }
  const Hs = H.map((s, i) => ({ ...s, i })).sort((a, b) => a.pos - b.pos);
  for (let a = 0; a < Hs.length; a++) {
    for (let b = a + 1; b < Hs.length && Hs[b].pos - Hs[a].pos <= tol; b++) {
      const oa = Hs[a], ob = Hs[b];
      if (Math.min(ob.to, oa.to) - Math.max(ob.from, oa.from) >= 8) union(hi(oa.i), hi(ob.i));
    }
  }
  for (let a = 0; a < Vs.length; a++) {
    for (let b = a + 1; b < Vs.length && Vs[b].pos - Vs[a].pos <= tol; b++) {
      const oa = Vs[a], ob = Vs[b];
      if (Math.min(ob.to, oa.to) - Math.max(ob.from, oa.from) >= 8) union(vi(oa.j), vi(ob.j));
    }
  }

  const groups = new Map();
  for (let i = 0; i < H.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { h: [], v: [] });
    groups.get(r).h.push(H[i]);
  }
  for (let j = 0; j < V.length; j++) {
    const r = find(H.length + j);
    if (!groups.has(r)) groups.set(r, { h: [], v: [] });
    groups.get(r).v.push(V[j]);
  }
  const comps = [...groups.values()].filter((c) => c.h.length + c.v.length >= 3);
  for (const c of comps) {
    const xs = [];
    const ys = [];
    for (const s of c.h) {
      xs.push(s.from, s.to);
      ys.push(s.pos);
    }
    for (const s of c.v) {
      xs.push(s.pos);
      ys.push(s.from, s.to);
    }
    c.bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }
  return comps;
}

function joinEdges(segs, tol = 3) {
  const byPos = new Map();
  for (const s of segs) {
    const k = Math.round(s.pos);
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k).push({ from: Math.min(s.from, s.to), to: Math.max(s.from, s.to) });
  }
  const out = [];
  for (const [k, list] of byPos) {
    list.sort((a, b) => a.from - b.from);
    let cur = null;
    for (const sg of list) {
      if (cur && sg.from <= cur.to + tol) cur.to = Math.max(cur.to, sg.to);
      else {
        if (cur) out.push({ pos: k, from: cur.from, to: cur.to });
        cur = { from: sg.from, to: sg.to };
      }
    }
    if (cur) out.push({ pos: k, from: cur.from, to: cur.to });
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

// Require repeated gaps on separate baselines before splitting a cell.
function alignedCellSplit(words, size) {
  if (words.length < 6) return null;
  const ordered = [...words].sort((a, b) => a.x0 - b.x0 || a.y - b.y);
  const evidence = [];
  for (let i = 0; i < ordered.length; i++) {
    const left = ordered[i];
    let nearest = null;
    for (let j = i + 1; j < ordered.length; j++) {
      const right = ordered[j];
      if (right.x0 < left.x1) continue;
      if (Math.abs(right.y - left.y) > 1.45 * size) continue;
      if (!nearest || right.x0 < nearest.x0) nearest = right;
    }
    if (!nearest) continue;
    const gap = nearest.x0 - left.x1;
    if (gap < Math.max(6, 1.2 * size)) continue;
    evidence.push({ x: (left.x1 + nearest.x0) / 2, y: (left.y + nearest.y) / 2, gap });
  }
  if (evidence.length < 2) return null;

  const tol = Math.max(2, 0.8 * size);
  const groups = [];
  for (const e of evidence.sort((a, b) => a.x - b.x)) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(e.x - last.x) <= tol) {
      last.items.push(e);
      last.x += (e.x - last.x) / last.items.length;
    } else groups.push({ x: e.x, items: [e] });
  }
  const candidates = groups.map((g) => {
    const ys = [];
    for (const e of [...g.items].sort((a, b) => a.y - b.y)) {
      const last = ys[ys.length - 1];
      if (last == null || e.y - last > 0.55 * size) ys.push(e.y);
      else ys[ys.length - 1] += (e.y - ys[ys.length - 1]) / 2;
    }
    return { x: g.x, rows: ys.length, support: g.items.length, gap: median(g.items.map((e) => e.gap)) };
  }).filter((g) => g.rows >= 2);
  candidates.sort((a, b) => b.rows - a.rows || b.support - a.support || b.gap - a.gap);
  return candidates[0]?.x ?? null;
}

function joinCellBands(words, size) {
  const bands = [];
  for (const w of [...words].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = bands[bands.length - 1];
    if (!last || w.y - last.y > 0.55 * size) bands.push({ y: w.y, words: [w] });
    else {
      last.words.push(w);
      last.y += (w.y - last.y) / last.words.length;
    }
  }
  return bands.map((b) => b.words.sort((a, b) => a.x0 - b.x0).map((w) => w.str).join(' ')).join(' ');
}

export function joinCellText(cellWords, fallbackSize = 9) {
  if (!cellWords || !cellWords.length) return '';
  const sizes = cellWords.map((w) => w.size || fallbackSize).filter((n) => n > 0);
  const size = median(sizes) || fallbackSize;
  const split = alignedCellSplit(cellWords, size);
  if (split != null) {
    const left = cellWords.filter((w) => (w.x0 + w.x1) / 2 < split);
    const right = cellWords.filter((w) => (w.x0 + w.x1) / 2 >= split);
    if (left.length >= 2 && right.length >= 2) {
      return `${joinCellBands(left, size)} | ${joinCellBands(right, size)}`;
    }
  }
  return joinCellBands(cellWords, size);
}


const coverLen = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function analyzeGrid({ ys, xs, Hc, Vc, rows, rotated = [], diags = [] }) {
  const nR = ys.length - 1;
  const nC = xs.length - 1;
  if (nR < 1 || nC < 1) return null;
  const hasBottom = (i, j) => {
    for (const s of Hc) {
      if (Math.abs(s.pos - ys[i + 1]) <= 3 && coverLen(s.from, s.to, xs[j], xs[j + 1]) >= 0.6 * (xs[j + 1] - xs[j])) return true;
    }
    return false;
  };
  const hasRight = (i, j) => {
    for (const s of Vc) {
      if (Math.abs(s.pos - xs[j + 1]) <= 3 && coverLen(s.from, s.to, ys[i], ys[i + 1]) >= 0.6 * (ys[i + 1] - ys[i])) return true;
    }
    return false;
  };
  const cellText = (i, j) => (rows[i] && rows[i][j] ? rows[i][j].trim() : '');
  const claimed = new Set();
  const spans = [];
  let maxColspan = 1;
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < nC; j++) {
      if (claimed.has(`${i},${j}`)) continue;
      let cs = 1;
      while (cs < 12 && j + cs < nC && !hasRight(i, j + cs - 1) && !cellText(i, j + cs)) cs++;
      let rs = 1;
      while (rs < 12 && i + rs < nR && !hasBottom(i + rs - 1, j) && !cellText(i + rs, j)) rs++;
      if (cs > 1 || rs > 1) {
        let ok = true;
        for (let a = i; a < i + rs && ok; a++) {
          for (let b = j; b < j + cs && ok; b++) {
            if (a === i && b === j) continue;
            if (cellText(a, b)) ok = false;
          }
        }
        if (ok) {
          spans.push({ r: i, c: j, rowspan: rs, colspan: cs });
          if (cs > maxColspan) maxColspan = cs;
          for (let a = i; a < i + rs; a++) for (let b = j; b < j + cs; b++) if (a !== i || b !== j) claimed.add(`${a},${b}`);
        }
      }
    }
  }

  // End the header band at the first numeric row.
  const isNum = (t) => /^[()\d.,/\s\-+%×:]{0,}$/.test(t) && /\d/.test(t);
  const numRatio = (r) => {
    const cells = rows[r].map((c) => c.trim()).filter(Boolean);
    if (!cells.length) return 0;
    return cells.filter((c) => isNum(c)).length / cells.length;
  };
  let hr = 0;
  while (hr < Math.min(3, nR - 1) && numRatio(hr) < 0.25) hr++;
  const headerRows = Math.max(1, Math.min(hr, nR - 1));

  const fillRatio = rows.flat().filter((c) => c.trim()).length / (nR * nC);
  const groupRows = [];
  if (fillRatio >= 0.3) {
    for (let r = headerRows; r < nR; r++) {
      const filled = rows[r].map((c, j) => [c, j]).filter(([c]) => c.trim());
      if (filled.length === 1 && filled[0][0].trim().length <= 26 && !/^[☑☐☒✓]/.test(filled[0][0])) groupRows.push(r);
    }
  }

  const totalRows = [];
  for (let i = 0; i < nR; i++) {
    const y = ys[i + 1];
    const near = Hc.filter((s) => Math.abs(s.pos - y) <= 4 && coverLen(s.from, s.to, xs[0], xs[nC]) >= 0.45 * (xs[nC] - xs[0]));
    const poss = [...new Set(near.map((s) => Math.round(s.pos * 2) / 2))].sort((a, b) => a - b);
    for (let k = 1; k < poss.length; k++) if (poss[k] - poss[k - 1] <= 5 && poss[k] - poss[k - 1] > 1.2) { totalRows.push(i); break; }
  }

  const rotatedHeaders = [];
  const bandTop = ys[0] - 4;
  const bandBottom = ys[Math.min(headerRows, nR)] + 3;
  if (bandBottom > bandTop) {
    const perCol = new Map();
    for (const rw of rotated) {
      const cx = (rw.x0 + rw.x1) / 2;
      if (rw.y < bandTop || rw.y > bandBottom) continue;
      let col = -1;
      for (let j = 0; j < nC; j++) if (cx >= xs[j] - 3 && cx <= xs[j + 1] + 3) col = j;
      if (col < 0) continue;
      if (!perCol.has(col)) perCol.set(col, []);
      perCol.get(col).push(rw);
    }
    for (const [col, list] of perCol) {
      list.sort((a, b) => a.y - b.y);
      const text = list.map((w) => w.str.trim()).filter(Boolean).join(' ').trim();
      if (text) rotatedHeaders.push({ col, text: text.slice(0, 40), isRotatedHeader: true });
    }
    rotatedHeaders.sort((a, b) => a.col - b.col);
  }

  let diagonal = null;
  if (diags.length) {
    const cx0 = xs[0], cx1 = xs[1], cy0 = ys[0], cy1 = ys[1];
    for (const [ax, ay, bx, by] of diags) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      if (mx < cx0 || mx > cx1 || my < cy0 || my > cy1) continue;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5 * Math.hypot(cx1 - cx0, cy1 - cy0)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const above = [];
      const below = [];
      for (const w of words || []) {
        if (w.x0 < cx0 - 1 || w.x1 > cx1 + 1 || w.y < cy0 - 1 || w.y > cy1 + 1) continue;
        const side = dx * (w.y - ay) - dy * (w.x0 - ax);
        (side > 0 ? above : below).push(w);
      }
      above.sort((a, b) => a.x0 - b.x0);
      below.sort((a, b) => a.x0 - b.x0);
      diagonal = {
        a: above.map((w) => w.str).join(' ').trim().slice(0, 40),
        b: below.map((w) => w.str).join(' ').trim().slice(0, 40),
      };
      break;
    }
  }

  if (!spans.length && !groupRows.length && !totalRows.length && !rotatedHeaders.length && !diagonal) return null;
  return { spans, headerRows, groupRows, totalRows, rotatedHeaders, diagonal };
}


export function detectRuledTables(words, segments, pageW, pageH, opts = {}) {
  const tables = [];
  // Use a wider tolerance for fragmented rules from scans.
  const comps = partitionComponents(segments, opts.tol || 4);
  for (const comp of comps) {
    detectRuledInComponent(words, comp, pageW, pageH, opts, tables);
  }
  if (!tables.some((table) => table.rows.length === 2)) return tables;
  const horizontal = joinEdges(segments.h || []);
  const vertical = joinEdges(segments.v || []);
  return tables.map((table) => table.rows.length === 2
    ? extendRuledHeader(table, words, horizontal, vertical) || table : table);
}

function extendRuledHeader(table, words, horizontal, vertical) {
  const { x0, x1, y0, y1 } = table.bbox;
  const headerRules = vertical.filter((s) => s.pos >= x0 - 2 && s.pos <= x1 + 2 &&
    s.from < y1 - 5 && Math.abs(s.to - y1) <= 2);
  const xs = cluster1d(headerRules, (s) => s.pos, 2).map((c) => c.key);
  if (xs.length < 5 || Math.abs(xs[0] - x0) > 2 || Math.abs(xs.at(-1) - x1) > 2) return null;
  const bottomRules = cluster1d(horizontal.filter((s) =>
    s.pos > y1 + 4 && Math.abs(s.from - x0) <= 3 && Math.abs(s.to - x1) <= 3), (s) => s.pos, 2);
  if (bottomRules.length < 5) return null;
  const spacing = bottomRules[0].key - y1;
  if (spacing < 7 || spacing > 25) return null;
  const headerDivider = horizontal.find((s) => s.pos > y0 + 5 && s.pos < y1 - 5 &&
    s.from > x0 + 5 && s.to < x1 - 5 && s.to - s.from > 15);
  if (!headerDivider) return null;
  const ys = [y0, headerDivider.pos, y1];
  for (const { key } of bottomRules) {
    if (Math.abs(key - ys.at(-1) - spacing) > Math.max(2, 0.21 * spacing)) break;
    ys.push(key);
  }
  if (ys.length < 8) return null;
  const rows = ys.slice(1).map((bottom, r) => {
    const band = words.filter((w) => w.y >= ys[r] && w.y < bottom);
    return xs.slice(1).map((right, c) => joinCellText(band.filter((w) => {
      const x = (w.x0 + w.x1) / 2;
      return x >= xs[c] && x < right;
    })));
  });
  const data = rows.slice(2);
  if (data.filter((row) => row[0] && row.at(-1) && row.slice(1, -1).some((value) => /^\d+$/.test(value))).length <
      0.75 * data.length) return null;
  const { spans = [] } = analyzeGrid({ ys: ys.slice(0, 3), xs, Hc: horizontal, Vc: vertical, rows: rows.slice(0, 2) }) || {};
  return { ...table, rows, spans, meta: { headerRows: 2 }, keepColumns: true, continuedHeader: true,
    bbox: { x0, y0, x1, y1: ys.at(-1) } };
}

function detectRuledInComponent(words, comp, pageW, pageH, opts, tables) {
  const { h: Hc, v: Vc, bbox: cbbox } = comp;
  let H = Hc.filter((s) => s.to - s.from > 8 && s.to - s.from < 0.95 * pageW);
  let V = Vc.filter((s) => s.to - s.from > 8 && s.to - s.from < 0.95 * pageH);
  H = joinEdges(H, 3);
  V = joinEdges(V, 3);
  if (H.length < 3 || V.length < 3) return;

  const hRows = cluster1d(H, (s) => s.pos, 2.5);
  const vCols = cluster1d(V, (s) => s.pos, 2.5);
  if (hRows.length < 3 || vCols.length < 3) return;

  const colSpan = [vCols[0].key, vCols[vCols.length - 1].key];
  const groups = [];
  for (const row of hRows) {
    const rowSpan = [Math.min(...row.items.map((s) => s.from)), Math.max(...row.items.map((s) => s.to))];
    const overlap = Math.min(rowSpan[1], colSpan[1]) - Math.max(rowSpan[0], colSpan[0]);
    if (overlap > 0.5 * (colSpan[1] - colSpan[0]) || overlap > 0.6 * (rowSpan[1] - rowSpan[0])) {
      const last = groups[groups.length - 1];
      if (last && row.key - last.rows[last.rows.length - 1].key < 90) last.rows.push(row);
      else groups.push({ rows: [row] });
    }
  }

  const xsAll = vCols.map((c) => c.key);
  for (const g of groups) {
    if (g.rows.length < 3) continue;
    const keys = g.rows.map((r) => r.key);
    const bands = [];
    for (let i = 0; i < keys.length - 1; i++) {
      const r = g.rows[i];
      bands.push({
        y0: keys[i],
        y1: keys[i + 1],
        from: Math.min(...r.items.map((s) => s.from)),
        to: Math.max(...r.items.map((s) => s.to)),
      });
    }
    // Split adjacent grids when their column counts differ.
    const activeV = (b) => V.filter((s) => s.from <= b.y0 + 2 && s.to >= b.y1 - 2).length;
    const subs = [];
    let cur = [bands[0]];
    for (let i = 1; i < bands.length; i++) {
      if (Math.abs(activeV(cur[cur.length - 1]) - activeV(bands[i])) >= 4) {
        subs.push(cur);
        cur = [bands[i]];
      } else {
        cur.push(bands[i]);
      }
    }
    subs.push(cur);

    for (const sub of subs) {
      if (sub.length < 2) continue;
      const ys = sub.map((b) => b.y0).concat([sub[sub.length - 1].y1]);
      const gx0 = Math.min(...sub.map((b) => b.from));
      const gx1 = Math.max(...sub.map((b) => b.to));
      const bbox = { x0: gx0, y0: ys[0], x1: gx1, y1: ys[ys.length - 1] };
      // A short value box in each form row does not define a column.
      const bboxH = bbox.y1 - bbox.y0;
      let xs = xsAll.filter((x) => x >= gx0 - 2 && x <= gx1 + 2);
      const nBands = ys.length - 1;
      const isTall = (x) => V.some((s) => Math.abs(s.pos - x) <= 2.5 && s.to - s.from >= 0.5 * bboxH);
      const bandSupport = (x) => {
        let n = 0;
        for (let i = 0; i < nBands; i++) {
          const by0 = ys[i];
          const by1 = ys[i + 1];
          if (V.some((s) => Math.abs(s.pos - x) <= 2.5 && s.to - s.from >= 0.6 * (by1 - by0) && s.from <= by0 + 2 && s.to >= by1 - 2)) n++;
        }
        return n;
      };
      const supported = xs.filter((x) => isTall(x) || bandSupport(x) >= Math.max(3, Math.ceil(0.55 * nBands)));
      if (supported.length >= 3 && (supported.length < xs.length || nBands >= 4)) xs = supported;
      // Keep short dividers that separate wrapped header text.
      const bandHs = [];
      for (let i = 0; i < nBands; i++) bandHs.push(ys[i + 1] - ys[i]);
      bandHs.sort((a, b) => a - b);
      const medBand = bandHs.length ? bandHs[Math.floor(bandHs.length / 2)] : 12;
      const dropCand = xsAll.filter(
        (x) => x > gx0 + 6 && x < gx1 - 6 && !xs.some((sx) => Math.abs(sx - x) <= 3)
      );
      const reintro = [];
      for (const dx of dropCand) {
        if (!V.some((s) => Math.abs(s.pos - dx) <= 2.5 && s.to - s.from >= 0.8 * medBand)) continue;
        const inGrid = words.filter(
          (w) => (w.x0 + w.x1) / 2 > bbox.x0 && (w.x0 + w.x1) / 2 < bbox.x1
        );
        if (inGrid.some((w) => w.x0 < dx - 1 && w.x1 > dx + 1)) continue;
        const hasGap = ys.some((by, i) => {
          if (i >= nBands) return false;
          const bw = inGrid.filter((w) => w.y > by + 1 && w.y < ys[i + 1] - 0.2);
          const l = bw.filter((w) => (w.x0 + w.x1) / 2 < dx);
          const r = bw.filter((w) => (w.x0 + w.x1) / 2 > dx);
          return (
            l.length &&
            r.length &&
            Math.min(...r.map((w) => w.x0)) - Math.max(...l.map((w) => w.x1)) >= 5
          );
        });
        if (hasGap) reintro.push(dx);
      }
      if (reintro.length && xs.length + reintro.length <= 25) {
        const mxs = [...xs, ...reintro].sort((a, b) => a - b);
        xs = [];
        for (const x of mxs) if (!xs.length || x - xs[xs.length - 1] > 3) xs.push(x);
      }
      // The first rule can sit to the right of the label column.
      if (xs.length >= 2 && gx0 < xs[0] - 24) xs = [gx0 + 1, ...xs];
      if (xs.length >= 2 && gx1 > xs[xs.length - 1] + 24) xs = [...xs, gx1 - 1];
      if (xs.length < 3) continue;
      if ((bbox.x1 - bbox.x0) > 0.95 * pageW || (bbox.y1 - bbox.y0) > 0.95 * pageH) continue;
      if (xs.length - 1 > 24) continue;
      if (ys.some((y, i) => i > 0 && y - ys[i - 1] > 48)) continue;

      const grid = [];
      for (let r = 0; r < ys.length - 1; r++) grid.push(new Array(xs.length - 1).fill(null));
      for (const w of words) {
        const cx = (w.x0 + w.x1) / 2;
        const cy = w.y;
        if (cx < bbox.x0 - 2 || cx > bbox.x1 + 2) continue;
        let r = -1;
        for (let i = 0; i < ys.length - 1; i++) if (cy > ys[i] + 1 && cy < ys[i + 1] - 0.2) r = i;
        if (r < 0) continue;
        let c = -1;
        for (let i = 0; i < xs.length - 1; i++) if (cx > xs[i] - 2 && cx < xs[i + 1] + 2) c = i;
        if (c < 0) continue;
        (grid[r][c] ||= []).push(w);
      }
      const spans = [];
      const width = xs.length - 1;
      const drawnSeparator = (r, c) => V.some((s) => Math.abs(s.pos - xs[c]) <= 2.5 &&
        s.from <= ys[r] + 2 && s.to >= ys[r + 1] - 2);
      const numeric = /^[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/u;
      const alignedNumericRows = grid.map((row, r) => r >= 2 && row.slice(1).every((cell) =>
        cell?.length === 1 && numeric.test(cell[0].str)));
      const continuesHeader = width >= 4 && alignedNumericRows.filter(Boolean).length >= 3 &&
        xs.slice(1, -1).every((_, c) => drawnSeparator(1, c + 1)) &&
        alignedNumericRows.some((yes, r) => yes && !drawnSeparator(r, 1));
      const separator = (r, c) => drawnSeparator(r, c) || (continuesHeader && r >= 2 && c > 0 && c < width);
      const divider = (c) => H.some((s) => Math.abs(s.pos - ys[1]) <= 2.5 &&
        coverLen(s.from, s.to, xs[c], xs[c + 1]) >= 0.8 * (xs[c + 1] - xs[c]));
      if (grid.length >= 4 && width >= 3) {
        const dividers = grid[0].map((_, c) => divider(c));
        const split = dividers.indexOf(true);
        if (split > 0 && dividers.slice(split).every(Boolean) &&
            ys[2] - ys[0] < 60 && xs.slice(1, -1).every((_, i) => separator(1, i + 1)) &&
            xs.slice(1, split + 1).every((_, i) => separator(0, i + 1))) {
          for (let c = 0; c < split; c++) {
            grid[0][c] = [...(grid[0][c] || []), ...(grid[1][c] || [])];
            grid[1][c] = null;
            spans.push({ r: 0, c, rowspan: 2, colspan: 1 });
          }
          for (let c = split; c < width; c++) {
            let end = c + 1;
            while (end < width && !separator(0, end)) end++;
            if (end === c + 1) continue;
            grid[0][c] = grid[0].slice(c, end).flatMap((cell) => cell || []);
            for (let j = c + 1; j < end; j++) grid[0][j] = null;
            spans.push({ r: 0, c, rowspan: 1, colspan: end - c });
            c = end - 1;
          }
        }
      }
      if (continuesHeader) {
        for (let r = 2; r < grid.length - 1; r++) {
          if (!alignedNumericRows[r] || !alignedNumericRows[r + 1] || !grid[r][0] || !grid[r + 1][0]) continue;
          const hasBoundary = (y, c) => H.some((s) => Math.abs(s.pos - y) <= 2.5 &&
            coverLen(s.from, s.to, xs[c], xs[c + 1]) >= 0.8 * (xs[c + 1] - xs[c]));
          if (!hasBoundary(ys[r], 0) || hasBoundary(ys[r + 1], 0) || !hasBoundary(ys[r + 2], 0) ||
              !xs.slice(1, -1).every((_, c) => hasBoundary(ys[r + 1], c + 1))) continue;
          grid[r][0].push(...grid[r + 1][0]);
          grid[r + 1][0] = null;
          spans.push({ r, c: 0, rowspan: 2, colspan: 1 });
          r++;
        }
      }
      for (let r = spans.length ? 2 : 0; r < grid.length; r++) {
        const top = ys[r];
        const bottom = ys[r + 1];
        const hasDivider = (c) => separator(r, c) || V.some((s) => Math.abs(s.pos - xs[c]) <= 2.5 &&
          coverLen(s.from, s.to, top, bottom) >= 0.4 * (bottom - top));
        for (let c = 0; c < width; c++) {
          if (!separator(r, c)) continue;
          let end = c + 1;
          while (end < width && !hasDivider(end)) end++;
          if (end === c + 1 || !separator(r, end)) continue;
          const left = xs[c];
          const right = xs[end];
          if (V.some((s) => s.pos > left + 3 && s.pos < right - 3 &&
              coverLen(s.from, s.to, top, bottom) >= 0.4 * (bottom - top))) continue;
          const enclosed = [top, bottom].every((y) => H.some((s) =>
            Math.abs(s.pos - y) <= 2.5 && s.from <= left + 3 && s.to >= right - 3));
          if (!enclosed) continue;
          const cells = grid[r].slice(c, end);
          if (cells.filter(Boolean).length < 2) continue;
          grid[r][c] = cells.flatMap((cell) => cell || []);
          grid[r].fill(null, c + 1, end);
          spans.push({ r, c, rowspan: 1, colspan: end - c });
          c = end - 1;
        }
      }
      const rows = grid.map((row) => row.map((cellWords) => joinCellText(cellWords)));
      // Skip sparse form grids unless their column boundaries are well supported.
      const filled = rows.flat().filter((c) => c.trim());
      if (filled.length < rows.length && filled.every((cell) => numeric.test(cell))) continue;
      let tallCols = 0;
      for (const x of xs) {
        const spans = V.filter((s) => Math.abs(s.pos - x) <= 2.5 && s.to - s.from >= 0.6 * bbox.y1 - 0.6 * bbox.y0);
        if (spans.length) tallCols++;
      }
      const confirmedForm = xs.length - 1 >= 4 && rows.length >= 4 && tallCols >= 0.7 * (xs.length - 1);
      const minFill = confirmedForm ? 0.12 : 0.35;
      if (filled.length / (rows.length * (xs.length - 1)) < minFill) continue;
      const meta = analyzeGrid({
        ys,
        xs,
        Hc: H.filter((s) => s.pos >= ys[0] - 2 && s.pos <= ys[ys.length - 1] + 2),
        Vc: [...V.filter((s) => s.pos >= xs[0] - 2 && s.pos <= xs[xs.length - 1] + 2),
          ...(continuesHeader ? xs.slice(1, -1).map((pos) => ({ pos, from: ys[2], to: ys.at(-1) })) : [])],
        rows,
        rotated: opts.rotated || [],
        diags: (opts.diags || []).filter((d) => d[0] >= bbox.x0 - 2 && d[0] <= bbox.x1 + 2 && d[1] >= bbox.y0 - 2 && d[1] <= bbox.y1 + 2),
      });
      const t = { rows, bbox, kind: 'ruled' };
      if (meta || spans.length) {
        const overlaps = (a, b) => a.r < b.r + b.rowspan && b.r < a.r + a.rowspan &&
          a.c < b.c + b.colspan && b.c < a.c + a.colspan;
        t.spans = [...spans, ...(meta?.spans || []).filter((s) => !spans.some((span) => overlaps(s, span)))];
        t.meta = { ...meta, ...(spans.some((s) => s.r === 0 && s.rowspan === 2) ? { headerRows: 2 } : {}) };
      }
      tables.push(t);
    }
  }
}


// Split a wide column where several rows share a gap.
function valleySplits(vlines, e0, e1, xs0) {
  const rowsWords = vlines
    .map((l) => l.words.filter((w) => (w.x0 + w.x1) / 2 >= e0 && (w.x0 + w.x1) / 2 < e1).sort((a, b) => a.x0 - b.x0))
    .filter((ws) => ws.length >= 2);
  if (rowsWords.length < 4) return [];
  const gaps = [];
  for (const l of vlines) {
    const ws = [...l.words].sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < ws.length; i++) {
      const g = ws[i].x0 - ws[i - 1].x1;
      if (g > 0.3 && g < 30) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  const mw = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3;
  const cands = [];
  for (const ws of rowsWords) {
    for (let i = 1; i < ws.length; i++) {
      const g = ws[i].x0 - ws[i - 1].x1;
      if (g >= 0.45 * mw) cands.push({ x: (ws[i].x0 + ws[i - 1].x1) / 2 });
    }
  }
  if (!cands.length) return [];
  const clusters = cluster1d(cands, (c) => c.x, 4);
  const splits = [];
  for (const c of clusters) {
    const support = new Set();
    for (const ws of rowsWords) {
      for (let i = 1; i < ws.length; i++) {
        const g = ws[i].x0 - ws[i - 1].x1;
        if (g >= 0.45 * mw && (ws[i].x0 + ws[i - 1].x1) / 2 >= c.key - 4 && (ws[i].x0 + ws[i - 1].x1) / 2 <= c.key + 4) {
          support.add(ws);
          break;
        }
      }
    }
    if (support.size / rowsWords.length >= 0.55) splits.push(c.key);
  }
  return splits.filter((x) => !xs0.some((v) => Math.abs(v - x) <= 4)).sort((a, b) => a - b).slice(0, 8);
}

export function detectSemiRuledTables(words, segments, pageW, pageH, opts = {}) {
  const tables = [];
  const comps = partitionComponents(segments, opts.tol || 4);
  // Don't reuse rules already assigned to a grid.
  const claimedH = new Set();
  for (const comp of comps) {
    if (comp.v.length >= 2) detectSemiRuledInComponent(words, comp, pageW, pageH, tables);
    if (comp.v.length >= 1) for (const h of comp.h) claimedH.add(h);
  }
  detectRowRulesGlobal(words, (segments.h || []).filter((s) => !claimedH.has(s)), pageW, pageH, tables);
  return tables;
}

// Horizontal-only tables have no intersecting rules, so group them by row spacing.
function detectRowRulesGlobal(words, H, pageW, pageH, tables) {
  const long = H.filter((s) => s.to - s.from >= 0.22 * pageW && s.to - s.from < 0.95 * pageW);
  if (long.length < 4) return;
  const rowKeys = cluster1d(long, (s) => s.pos, 2.5).map((c) => c.key).sort((a, b) => a - b);
  const itemsAt = (key) => long.filter((s) => Math.abs(s.pos - key) <= 2.5);
  const groups = [];
  for (const key of rowKeys) {
    const items = itemsAt(key);
    const from = Math.min(...items.map((s) => s.from));
    const to = Math.max(...items.map((s) => s.to));
    const g = groups[groups.length - 1];
    if (g) {
      const prev = g.rules[g.rules.length - 1];
      const ox = Math.min(prev.to, to) - Math.max(prev.from, from);
      if (key - prev.pos <= 60 && ox >= 0.5 * Math.min(prev.to - prev.from, to - from)) {
        g.rules.push({ pos: key, from, to });
        continue;
      }
    }
    groups.push({ rules: [{ pos: key, from, to }] });
  }
  for (const g of groups) {
    if (g.rules.length < 4) continue;
    const maxSpan = Math.max(...g.rules.map((r) => r.to - r.from));
    if (g.rules.some((r) => r.to - r.from < 0.55 * maxSpan)) continue;
    const keys = g.rules.map((r) => r.pos);
    const gx0 = Math.min(...g.rules.map((r) => r.from));
    const gx1 = Math.max(...g.rules.map((r) => r.to));
    const bbox = { x0: gx0, y0: keys[0], x1: gx1, y1: keys[keys.length - 1] };
    if (bbox.y1 - bbox.y0 < 48 || bbox.y1 - bbox.y0 > 0.9 * pageH) continue;
    const inRegion = words.filter((w) => {
      const cx = (w.x0 + w.x1) / 2;
      return cx > gx0 - 2 && cx < gx1 + 2 && w.y > keys[0] + 1 && w.y < keys[keys.length - 1] - 0.5;
    });
    if (inRegion.length < 16) continue;
    const size = Math.max(4, ...inRegion.map((w) => w.size));
    inRegion.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const vlines = [];
    for (const w of inRegion) {
      const last = vlines[vlines.length - 1];
      if (last && w.y - last.y <= 0.6 * size) {
        last.words.push(w);
        last.y += (w.y - last.y) / last.words.length;
      } else vlines.push({ y: w.y, words: [w], size: w.size });
    }
    vlines.forEach((l) => l.words.sort((a, b) => a.x0 - b.x0));
    // Right edges help locate numeric columns when label widths vary.
    const numTok = (t) => /^[()]*[\d.,/%]+[\d.,/%)×:]*$/.test(t.trim()) && /\d/.test(t.trim());
    const rowsNum = vlines.map((l) => l.words.filter((w) => numTok(w.str)));
    const nRowsNum = rowsNum.filter((ws) => ws.length).length;
    const numEdges = [];
    if (nRowsNum >= 4) {
      const cands = [];
      for (const ws of rowsNum) for (const w of ws) cands.push({ x: w.x1 });
      for (const c of cluster1d(cands, (o) => o.x, 6)) {
        if (c.items.length >= Math.max(3, 0.25 * nRowsNum) && c.key > gx0 + 30 && c.key < gx1 - 12) numEdges.push(c.key + 4);
      }
    }
    const splits = valleySplits(vlines, gx0, gx1, []);
    const midEdges = [...splits, ...numEdges].filter((x) => x > gx0 + 12 && x < gx1 - 12).sort((a, b) => a - b);
    const mergedEdges = [];
    for (const x of midEdges) if (!mergedEdges.length || x - mergedEdges[mergedEdges.length - 1] > 6) mergedEdges.push(x);
    const edges = [gx0 - 2, ...mergedEdges, gx1 + 1];
    const nCols = edges.length - 1;
    if (nCols < 2 || nCols > 16) continue;
    const lineCells = (l) => {
      const cs = new Array(nCols).fill('');
      for (const w of l.words) {
        const cx = (w.x0 + w.x1) / 2;
        for (let i = 0; i < nCols; i++) {
          if (cx >= edges[i] && cx < edges[i + 1]) {
            cs[i] = cs[i] ? cs[i] + ' ' + w.str : w.str;
            break;
          }
        }
      }
      return cs;
    };
    const isNumeric = (t) => /^[()\d.,/\s\-+×:%]{1,}$/.test(t.trim()) && /\d/.test(t.trim());
    const rows = [];
    let curRow = null;
    for (const l of vlines) {
      const cs = lineCells(l);
      const fillsNumeric = cs.slice(1).some((c) => c.trim() && isNumeric(c));
      const closeUnder = curRow && l.y - curRow.lastY <= 1.6 * size;
      if (curRow && !fillsNumeric && closeUnder) {
        for (let i = 0; i < cs.length; i++) if (cs[i].trim()) curRow.cells[i] = (curRow.cells[i] + ' ' + cs[i]).trim();
        curRow.lastY = l.y;
      } else {
        curRow = { cells: cs, lastY: l.y };
        rows.push(curRow);
      }
    }
    const table = rows.map((r) => r.cells);
    if (table.length < 5) continue;
    const filled = table.flat().filter((c) => c.trim()).length;
    if (filled / (table.length * nCols) < 0.3) continue;
    // Reject isolated runs of schematic values.
    let numericCols = 0;
    for (let ci = 1; ci < nCols; ci++) {
      const col = table.map((r) => r[ci]).filter((c) => c.trim());
      if (col.length >= 3 && col.filter((c) => isNumeric(c)).length >= 0.5 * col.length) numericCols++;
    }
    if (numericCols < 2) continue;
    tables.push({ rows: table, bbox, kind: 'ruled' });
  }
}

function detectSemiRuledInComponent(words, comp, pageW, pageH, tables) {
  const V = comp.v.filter((s) => s.to - s.from > 24 && s.to - s.from < 0.9 * pageH);
  const H = comp.h.filter((s) => s.to - s.from > 40 && s.to - s.from < 0.95 * pageW);
  if (V.length < 2 || H.length < 2) return;
  const vCols = cluster1d(V, (s) => s.pos, 3);
  if (vCols.length < 3) return;
  const hRules = cluster1d(H, (s) => s.pos, 2.5).map((c) => c.key);
  if (hRules.length < 2) return;

  const candidates = [];
  for (let i = 0; i < hRules.length; i++) {
    for (let j = i + 1; j < hRules.length; j++) {
      const y0 = hRules[i];
      const y1 = hRules[j];
      const hgt = y1 - y0;
      if (hgt < 70 || hgt > 0.9 * pageH) continue;
      const spanning = vCols.filter((c) => {
        const lo = Math.min(...c.items.map((s) => s.from));
        const hi = Math.max(...c.items.map((s) => s.to));
        const cover = Math.min(hi, y1 - 2) - Math.max(lo, y0 + 2);
        return cover >= 0.5 * hgt;
      });
      if (spanning.length < 3) continue;
      candidates.push({ y0, y1, xs: spanning.map((c) => c.key) });
    }
  }
  candidates.sort((a, b) => b.xs.length * (b.y1 - b.y0) - a.xs.length * (a.y1 - a.y0));
  const taken = [];
  for (const cand of candidates) {
    if (
      taken.some((t) => cand.y0 >= t.y0 - 4 && cand.y1 <= t.y1 + 4 && cand.xs[0] >= t.xs[0] - 4 && cand.xs[cand.xs.length - 1] <= t.xs[t.xs.length - 1] + 4)
    ) continue;
    taken.push(cand);
  }

  for (const { y0, y1, xs: xs0 } of taken) {
    const gx0 = Math.min(...xs0);
    const gx1 = Math.max(...xs0);
    const bbox = { x0: gx0, y0, x1: gx1, y1 };
    if ((gx1 - gx0) > 0.95 * pageW) continue;
    const inRegion = words.filter((w) => {
      const cx = (w.x0 + w.x1) / 2;
      return cx > gx0 - 2 && cx < gx1 + 2 && w.y > y0 + 1 && w.y < y1 - 0.5;
    });
    if (inRegion.length < 12) continue;
    const size = Math.max(4, ...inRegion.map((w) => w.size));

    inRegion.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const vlines = [];
    for (const w of inRegion) {
      const last = vlines[vlines.length - 1];
      if (last && w.y - last.y <= 0.6 * size) {
        last.words.push(w);
        last.y += (w.y - last.y) / last.words.length;
      } else {
        vlines.push({ y: w.y, words: [w], size: w.size });
      }
    }
    vlines.forEach((l) => l.words.sort((a, b) => a.x0 - b.x0));

    const isNumeric = (t) => /^[()\d.,/\s\-+×:]{1,}$/.test(t.trim()) && /\d/.test(t);
    const edges0 = xs0.map((x) => x - 2).concat([gx1 + 1]);
    const probeCells = (l) => {
      const cells = new Array(xs0.length).fill('');
      for (const w of l.words) {
        const cx = (w.x0 + w.x1) / 2;
        for (let i = 0; i < xs0.length; i++) {
          if (cx >= edges0[i] && cx < edges0[i + 1]) {
            cells[i] = cells[i] ? cells[i] + ' ' + w.str : w.str;
            break;
          }
        }
      }
      return cells;
    };
    const extra = new Map();
    for (let ci = 0; ci < xs0.length; ci++) {
      const w0 = edges0[ci];
      const w1 = edges0[ci + 1];
      const colW = w1 - w0;
      const colWidths = xs0.map((x, i) => (i + 1 < xs0.length ? xs0[i + 1] - x : gx1 + 1 - x));
      const medianW = mean(colWidths);
      if (colW < 1.8 * medianW || ci === 0) continue;
      let numLines = 0;
      let contentLines = 0;
      for (const l of vlines) {
        const c = probeCells(l)[ci];
        if (!c.trim()) continue;
        contentLines++;
        if (isNumeric(c)) numLines++;
      }
      if (contentLines < 4 || numLines / contentLines < 0.4) continue;
      const splits = valleySplits(vlines, w0, w1, xs0);
      if (splits.length) extra.set(ci, splits);
    }
    const edges = [];
    for (let i = 0; i < xs0.length; i++) {
      edges.push(xs0[i] - 2);
      for (const s of extra.get(i) || []) if (s > xs0[i] + 4 && s < (i + 1 < xs0.length ? xs0[i + 1] - 4 : gx1 - 4)) edges.push(s);
    }
    edges.push(gx1 + 1);
    const nCols = edges.length - 1;
    if (nCols > 24) continue;

    const lineCells = (l) => {
      const cells = new Array(nCols).fill('');
      for (const w of l.words) {
        const cx = (w.x0 + w.x1) / 2;
        for (let i = 0; i < nCols; i++) {
          if (cx >= edges[i] && cx < edges[i + 1]) {
            cells[i] = cells[i] ? cells[i] + ' ' + w.str : w.str;
            break;
          }
        }
      }
      return cells;
    };
    const rows = [];
    let curRow = null;
    for (const l of vlines) {
      const cells = lineCells(l);
      const fillsNumeric = cells.slice(1).some((c) => c.trim() && isNumeric(c));
      const closeUnder = curRow && l.y - curRow.lastY <= 1.6 * size;
      if (curRow && !fillsNumeric && closeUnder) {
        for (let i = 0; i < cells.length; i++) {
          if (cells[i].trim()) curRow.cells[i] = (curRow.cells[i] + ' ' + cells[i]).trim();
        }
        curRow.lastY = l.y;
      } else {
        curRow = { cells, lastY: l.y };
        rows.push(curRow);
      }
    }

    const table = rows.map((r) => r.cells);
    if (table.length < 5) continue;
    const filled = table.flat().filter((c) => c.trim()).length;
    if (filled / (table.length * nCols) < 0.25) continue;
    const numericCols = [];
    for (let ci = 1; ci < nCols; ci++) {
      const col = table.map((r) => r[ci]).filter((c) => c.trim());
      if (col.length >= 4 && col.filter((c) => isNumeric(c)).length >= 0.5 * col.length) numericCols.push(ci);
    }
    if (numericCols.length < 2) continue;
    tables.push({ rows: table, bbox, kind: 'ruled' });
  }
}

const BULLET_RE = /^\s*([-–—*•▪◦●·‣⁃]\s+)/;
const ORDERED_RE = /^\s*(\d{1,2}|[a-zA-Z])[.)]\s+/;

export function findBorderlessTable(lines, options = {}) {
  if (lines.length < 3) return null;
  if (!options.windowed && lines.length > 8) {
    const size = mean(lines.map((line) => line.size));
    const gaps = lines.slice(1).map((line, index) => line.y - lines[index].y).filter((gap) => gap > 0).sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : size;
    const splitGap = Math.max(4.5 * size, 1.8 * medianGap);
    const runs = [];
    let run = [];
    for (const line of lines) {
      if (run.length && line.y - run.at(-1).y > splitGap) {
        runs.push(run);
        run = [];
      }
      run.push(line);
    }
    if (run.length) runs.push(run);
    const matches = runs.map((candidateLines) => findBorderlessTable(candidateLines, { windowed: true })).filter(Boolean);
    if (matches.length) {
      const rows = matches.flatMap((table, index) => index ? table.rows.slice(1) : table.rows);
      return { ...matches[0], rows, tables: matches };
    }
  }
  const size = mean(lines.map((l) => l.size));

  const tryClusters = (mode, coverage) => {
    const pts = [];
    lines.forEach((l) => l.words.forEach((w) => pts.push({ x: mode === 'start' ? w.x0 : w.x1, line: l, w })));
    return cluster1d(pts, (s) => s.x, Math.max(4, 0.4 * size)).filter((c) => {
      const lineSet = new Set(c.items.map((s) => s.line));
      return lineSet.size >= lines.length * coverage && c.items.length >= lines.length * coverage;
    });
  };

  // Require consistent word starts to avoid treating justified prose as a table.
  let clusters = tryClusters('start', options.windowed ? 0.8 : 1.0);
  let mode = 'start';
  if (clusters.length < 3 || clusters.length > 10) {
    // Financial tables often align numbers by their right edge.
    clusters = tryClusters('end', 0.6);
    mode = 'end';
    if (clusters.length < 2 || clusters.length > 10) return null;
  }

  const minHits = Math.min(3, clusters.length);
  let rowsWithMatch = 0;
  const byLine = new Map(lines.map((l) => [l, []]));
  for (const c of clusters) {
    for (const s of c.items) byLine.get(s.line)?.push(s);
  }
  for (const [, hits] of byLine) if (hits.length >= minHits) rowsWithMatch++;
  const minRowHit = Math.ceil(lines.length * (mode === 'end' ? 0.6 : 0.8));
  if (rowsWithMatch < minRowHit) return null;

  const bounds = clusters.map((c) => ({
    lo: Math.min(...c.items.map((s) => s.x)),
    hi: Math.max(...c.items.map((s) => s.x)),
  }));
  const minX0 = Math.min(...lines.map((l) => l.x0));
  if (mode === 'end') {
    const labelMax = Math.max(
      minX0,
      ...lines.flatMap((l) => l.words).filter((w) => w.x1 < bounds[0].lo - 5).map((w) => w.x1)
    );
    if (labelMax > minX0 + 8) bounds.unshift({ lo: minX0, hi: labelMax });
  }
  const edges = [Math.min(bounds[0].lo, minX0) - 3];
  for (let i = 0; i < bounds.length - 1; i++) edges.push((bounds[i].hi + bounds[i + 1].lo) / 2);
  edges.push(bounds[bounds.length - 1].hi + 200);

  if (mode === 'start') {
    const interior = edges.slice(1, -1);
    let supported = 0;
    for (const edge of interior) {
      let count = 0;
      for (const line of lines) {
        let left = -Infinity;
        let right = Infinity;
        for (const word of line.words) {
          if (word.x0 < edge) left = Math.max(left, word.x1);
          else right = Math.min(right, word.x0);
        }
        if (left <= edge && Number.isFinite(left) && Number.isFinite(right) &&
            right - left >= Math.max(6, 0.85 * size)) count++;
      }
      if (count >= 0.6 * lines.length) supported++;
    }
    if (supported < Math.ceil(0.6 * interior.length)) return null;
  }

  const rows = lines.map((l) => {
    const cells = new Array(bounds.length).fill('');
    for (const w of l.words) {
      const cx = mode === 'start' ? w.x0 : w.x1 - 0.5;
      for (let i = 0; i < bounds.length; i++) {
        if (cx >= edges[i] - 3 && cx < edges[i + 1]) {
          cells[i] = cells[i] ? cells[i] + ' ' + w.str : w.str;
          break;
        }
      }
    }
    return cells;
  });
  // Merge wrapped labels only with a nearby row.
  const meanSize = mean(lines.map((l) => l.size));
  const rowY = lines.map((l) => l.y);
  const closeRows = (i) => Math.abs(rowY[i + 1] - rowY[i]) <= 1.8 * meanSize;
  const onlyLabel = (r) => r[0].trim() && r.slice(1).every((c) => !c.trim());
  for (let i = 0; i < rows.length - 1; i++) {
    if (!closeRows(i)) continue;
    const a = rows[i];
    const b = rows[i + 1];
    if (onlyLabel(a) && b.slice(1).some((c) => c.trim())) {
      rows[i] = [(a[0] + ' ' + b[0]).trim(), ...b.slice(1)];
      rows.splice(i + 1, 1);
      rowY.splice(i + 1, 1);
      i--;
    } else if (onlyLabel(b) && a.slice(1).some((c) => c.trim())) {
      rows[i] = [(a[0] + ' ' + b[0]).trim(), ...a.slice(1)];
      rows.splice(i + 1, 1);
      rowY.splice(i + 1, 1);
      i--;
    }
  }

  const cellsTotal = rows.length * bounds.length;
  const cellsFilled = rows.flat().filter((c) => c.trim()).length;
  if (cellsFilled / cellsTotal < 0.5) return null;
  // Borderless forms often split an identifier and its wrapped label across
  // two inferred columns. Keep that label in one cell before Markdown output.
  for (let rowIndex = 2; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const first = row.findIndex((cell) => cell.trim());
    const numeric = row.findIndex((cell, index) => index > first && /^[()$\d.,/%+\-×:]+$/.test(cell.trim()));
    if (first < 0 || numeric <= first + 1 || !/^[A-Z]+\d{3,}[A-Z]+\d+/u.test(row[first].trim())) continue;
    row[first] = row.slice(first, numeric).filter(Boolean).join(' ');
    for (let index = first + 1; index < numeric; index++) row[index] = '';
  }
  const filled = rows.flat().filter((c) => c.trim());
  if (filled.length) {
    const meanWords = mean(filled.map((c) => c.trim().split(/\s+/).length));
    // Allow longer labels in Vietnamese, where spaces also separate syllables.
    if (meanWords > 6.5) return null;
  }
  // Right-edge alignment alone also matches justified prose.
  if (mode === 'end') {
    const dataCells = rows.slice(1).flat().filter((c) => c.trim());
    const numeric = dataCells.filter((c) => /^[()$%\d.,/\s\-+×:☐☑✓]+$/.test(c)).length;
    if (dataCells.length && numeric / dataCells.length < 0.4) return null;
  }
  return { start: 0, end: lines.length, rows, kind: 'borderless' };
}

export { BULLET_RE, ORDERED_RE };
